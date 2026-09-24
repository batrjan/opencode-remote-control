import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { viewerTokenFrom } from './helpers/viewer-token'
import { WebSocket } from 'ws'
import { startServer } from '../src/server'
import { config } from '../src/config'

/**
 * A request caught by a bridge reconnect.
 *
 * When the owner's link drops, the bridge re-dials within about a second —
 * but every viewer request in flight at that moment used to fail at once with
 * 502 "proxy failed". A GET is safe to send again, so it now waits for the
 * bridge to come back and is answered on the new socket. A POST is never sent
 * twice: a prompt delivered twice is not harmless.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
process.env.RELAY_BRIDGE_RECONNECT_WAIT_MS = '1500'

let relay: Server
let relayUrl: string

beforeEach(async () => {
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterEach(async () => {
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
})

async function share(session_id: string) {
  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id, directory: '/path', title: 'retry' })
  expect(created.status).toBe(201)
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id })
  return { bridgeToken: created.body.bridge_token as string, viewerToken: viewerTokenFrom(activated) }
}

type Proxy = { request_id: string; method: string; path: string }

/** A hand-driven bridge socket that records the proxy requests it is sent. */
async function bridgeSocket(session_id: string, bridgeToken: string) {
  const ws = new WebSocket(`${relayUrl.replace(/^http/, 'ws')}/bridge?session_id=${session_id}`, {
    headers: { 'x-bridge-token': bridgeToken },
  })
  const proxied: Proxy[] = []
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw))
    if (msg.type === 'proxy') proxied.push(msg)
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const next = async (ms = 3000) => {
    const deadline = Date.now() + ms
    while (proxied.length === 0) {
      if (Date.now() > deadline) return undefined
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return proxied.shift()
  }
  const answer = (p: Proxy, body: unknown) =>
    ws.send(JSON.stringify({ type: 'proxy_response', request_id: p.request_id, status: 200, contentType: 'application/json', body: JSON.stringify(body) }))
  return { ws, next, answer }
}

test('a GET caught by a reconnect is answered on the new socket', async () => {
  const { bridgeToken, viewerToken } = await share('ses_retry_get')
  const first = await bridgeSocket('ses_retry_get', bridgeToken)
  const view = request(relay).get('/session/ses_retry_get/message').set('x-viewer-token', viewerToken).then((r) => r)

  const caught = await first.next()
  expect(caught?.method).toBe('GET')
  // The link drops with the request in flight; the bridge re-dials a moment later.
  first.ws.terminate()
  await new Promise((resolve) => setTimeout(resolve, 300))
  const second = await bridgeSocket('ses_retry_get', bridgeToken)
  const again = await second.next()
  expect(again?.path).toBe(caught?.path)
  second.answer(again!, [{ id: 'm1' }])

  const res = await view
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'm1' }])
  second.ws.terminate()
}, 15_000)

test('a GET caught by a socket the bridge replaced is answered on the new socket at once', async () => {
  // The bridge noticed the dead link first and re-dialled, so the relay
  // replaces a socket it still counts as open instead of seeing it close. The
  // request in that socket used to sit out the whole proxy timeout (30 s) and
  // then end in a 504, never repeated.
  const { bridgeToken, viewerToken } = await share('ses_retry_replaced')
  const first = await bridgeSocket('ses_retry_replaced', bridgeToken)
  const view = request(relay).get('/session/ses_retry_replaced/message').set('x-viewer-token', viewerToken).then((r) => r)

  const caught = await first.next()
  expect(caught?.method).toBe('GET')
  const replacedAt = Date.now()
  const second = await bridgeSocket('ses_retry_replaced', bridgeToken)
  const again = await second.next(3000)
  expect(again?.path).toBe(caught?.path)
  second.answer(again!, [{ id: 'm1' }])

  const res = await view
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'm1' }])
  expect(Date.now() - replacedAt).toBeLessThan(5000)
  second.ws.terminate()
}, 15_000)

/** Resolves once the relay has dropped a socket it replaced, and a moment more for its 'close' to run. */
async function replacedClosed(ws: WebSocket) {
  if (ws.readyState !== WebSocket.CLOSED) await new Promise((resolve) => ws.once('close', resolve))
  await new Promise((resolve) => setTimeout(resolve, 200))
}

test('a POST caught by a socket the bridge replaced is answered on the new socket and never sent again', async () => {
  // A bridge answers on whichever socket is current, so a shell command that
  // opencode was still running when the bridge re-dialled is answered on the
  // new socket. Failed when the replaced socket closed, that answer found
  // nothing waiting: the viewer got a 502 for a command that ran, and the web
  // UI puts a failed command back in the input to be sent — and run — again.
  const { bridgeToken, viewerToken } = await share('ses_retry_replaced_post')
  const first = await bridgeSocket('ses_retry_replaced_post', bridgeToken)
  const view = request(relay)
    .post('/session/ses_retry_replaced_post/shell')
    .set('x-viewer-token', viewerToken)
    .send({ agent: 'build', command: 'make test' })
    .then((r) => r)

  const caught = await first.next()
  expect(caught?.method).toBe('POST')
  const second = await bridgeSocket('ses_retry_replaced_post', bridgeToken)
  // The relay has dropped the replaced socket; opencode finishes after that.
  await replacedClosed(first.ws)
  second.answer(caught!, { id: 'msg_shell' })

  const res = await view
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ id: 'msg_shell' })
  expect(await second.next(800)).toBeUndefined()
  second.ws.terminate()
}, 15_000)

test('a POST moved to the new socket fails at once when that socket drops too', async () => {
  const { bridgeToken, viewerToken } = await share('ses_retry_moved_drop')
  const first = await bridgeSocket('ses_retry_moved_drop', bridgeToken)
  const view = request(relay)
    .post('/session/ses_retry_moved_drop/command')
    .set('x-viewer-token', viewerToken)
    .send({ command: 'review', arguments: '' })
    .then((r) => r)

  expect((await first.next())?.method).toBe('POST')
  const second = await bridgeSocket('ses_retry_moved_drop', bridgeToken)
  await replacedClosed(first.ws)
  const droppedAt = Date.now()
  second.ws.terminate()

  const res = await Promise.race([view, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000))])
  expect(res?.status).toBe(502)
  expect(Date.now() - droppedAt).toBeLessThan(5000)
  // The bridge comes back; the command must not follow it.
  const third = await bridgeSocket('ses_retry_moved_drop', bridgeToken)
  expect(await third.next(800)).toBeUndefined()
  third.ws.terminate()
}, 15_000)

test('a POST caught by a socket the bridge replaced and never answered ends at its own timeout, never sent again', async () => {
  const savedTimeout = config.proxyTimeoutMs
  ;(config as { proxyTimeoutMs: number }).proxyTimeoutMs = 1500
  try {
    const { bridgeToken, viewerToken } = await share('ses_retry_moved_silent')
    const first = await bridgeSocket('ses_retry_moved_silent', bridgeToken)
    const started = Date.now()
    const view = request(relay)
      .post('/session/ses_retry_moved_silent/summarize')
      .set('x-viewer-token', viewerToken)
      .send({ providerID: 'p', modelID: 'm' })
      .then((r) => r)

    expect((await first.next())?.method).toBe('POST')
    const second = await bridgeSocket('ses_retry_moved_silent', bridgeToken)
    const res = await view
    expect(res.status).toBe(504)
    expect(res.body).toEqual({ error: 'proxy timeout' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400)
    expect(await second.next(0)).toBeUndefined()
    second.ws.terminate()
  } finally {
    ;(config as { proxyTimeoutMs: number }).proxyTimeoutMs = savedTimeout
  }
}, 15_000)

test('a POST caught by a reconnect fails and is never sent again', async () => {
  const { bridgeToken, viewerToken } = await share('ses_retry_post')
  const first = await bridgeSocket('ses_retry_post', bridgeToken)
  const view = request(relay)
    .post('/session/ses_retry_post/prompt_async')
    .set('x-viewer-token', viewerToken)
    .send({ parts: [{ type: 'text', text: 'deploy to production' }] })
    .then((r) => r)

  const caught = await first.next()
  expect(caught?.method).toBe('POST')
  first.ws.terminate()
  const res = await view
  expect(res.status).toBe(502)

  // The bridge comes back; the prompt must not follow it.
  const second = await bridgeSocket('ses_retry_post', bridgeToken)
  expect(await second.next(800)).toBeUndefined()
  second.ws.terminate()
}, 15_000)

test('a GET gives up when the bridge does not come back in time', async () => {
  const { bridgeToken, viewerToken } = await share('ses_retry_gone')
  const first = await bridgeSocket('ses_retry_gone', bridgeToken)
  const started = Date.now()
  const view = request(relay).get('/session/ses_retry_gone/message').set('x-viewer-token', viewerToken).then((r) => r)
  await first.next()
  first.ws.terminate()
  const res = await view
  expect(res.status).toBe(502)
  expect(Date.now() - started).toBeGreaterThanOrEqual(1400)
  expect(Date.now() - started).toBeLessThan(5000)
}, 15_000)

test('a share whose bridge never connected still fails fast', async () => {
  // Holding requests only makes sense for a bridge that is re-dialling; one
  // that was never there must not stall every viewer request.
  const { viewerToken } = await share('ses_retry_never')
  const started = Date.now()
  const res = await request(relay).get('/session/ses_retry_never/message').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(502)
  expect(Date.now() - started).toBeLessThan(500)
})

test('a GET is repeated at most once', async () => {
  const { bridgeToken, viewerToken } = await share('ses_retry_once')
  const first = await bridgeSocket('ses_retry_once', bridgeToken)
  const view = request(relay).get('/session/ses_retry_once/message').set('x-viewer-token', viewerToken).then((r) => r)
  await first.next()
  first.ws.terminate()
  const second = await bridgeSocket('ses_retry_once', bridgeToken)
  expect(await second.next()).toBeDefined()
  // Dropped again: this time the viewer gets the error.
  second.ws.terminate()
  const third = await bridgeSocket('ses_retry_once', bridgeToken)
  const res = await view
  expect(res.status).toBe(502)
  expect(await third.next(500)).toBeUndefined()
  third.ws.terminate()
}, 15_000)
