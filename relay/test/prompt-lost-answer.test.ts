import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { viewerTokenFrom } from './helpers/viewer-token'
import { WebSocket } from 'ws'
import { startServer } from '../src/server'
import { config } from '../src/config'

/**
 * A prompt that reached opencode, whose answer did not reach the viewer.
 *
 * opencode takes a prompt, forks the turn and answers 204 in a few tens of
 * milliseconds. Every failure after the relay has sent it is therefore a lost
 * or late answer, not a prompt that was refused: on the owner's slow uplink the
 * 204 queued behind megabytes of other traffic until the relay's 30 s timer
 * answered 504, or the link dropped with the 204 in the dead socket and the
 * relay answered 502. The web UI takes any error as "not sent" — it removes the
 * message, puts the text back in the input and shows a toast — so the viewer
 * pressed send again and opencode ran the same turn twice.
 *
 * The prompt is still never sent twice. The relay now asks opencode whether the
 * message the UI named in `messageID` exists and, if it does, answers the 204
 * opencode gave.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
process.env.RELAY_BRIDGE_RECONNECT_WAIT_MS = '1500'
process.env.RELAY_PROMPT_TIMEOUT_MS = '1000'

let relay: Server
let relayUrl: string
const savedTimeout = config.proxyTimeoutMs

beforeEach(async () => {
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterEach(async () => {
  ;(config as { proxyTimeoutMs: number }).proxyTimeoutMs = savedTimeout
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
})

async function share(session_id: string) {
  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id, directory: '/path', title: 'prompt' })
  expect(created.status).toBe(201)
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id })
  return { bridgeToken: created.body.bridge_token as string, viewerToken: viewerTokenFrom(activated) }
}

type Proxy = { request_id: string; method: string; path: string; body?: unknown }

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
  const answer = (p: Proxy, status: number, body: unknown) =>
    ws.send(
      JSON.stringify({
        type: 'proxy_response',
        request_id: p.request_id,
        status,
        contentType: 'application/json',
        body: body === undefined ? '' : JSON.stringify(body),
      }),
    )
  return { ws, next, answer }
}

const prompt = (messageID?: string) => ({
  ...(messageID === undefined ? {} : { messageID }),
  parts: [{ type: 'text', text: 'please run the migration once' }],
})

/** What opencode answers for GET /session/:id/message/:messageID when it has the message. */
const stored = (session_id: string, messageID: string) => ({
  info: { id: messageID, sessionID: session_id, role: 'user' },
  parts: [],
})

test('a prompt whose answer is lost to a reconnect is reported accepted once opencode has the message', async () => {
  const { bridgeToken, viewerToken } = await share('ses_lost_drop')
  const first = await bridgeSocket('ses_lost_drop', bridgeToken)
  const view = request(relay)
    .post('/session/ses_lost_drop/prompt_async')
    .set('x-viewer-token', viewerToken)
    .send(prompt('msg_0a1b2c3d4e5fAbCdEf01234567'))
    .then((r) => r)

  const sent = await first.next()
  expect(sent?.method).toBe('POST')
  // opencode took it; the link drops before its 204 gets back.
  first.ws.terminate()
  await new Promise((resolve) => setTimeout(resolve, 300))

  const second = await bridgeSocket('ses_lost_drop', bridgeToken)
  const check = await second.next()
  expect(check?.method).toBe('GET')
  expect(check?.path.split('?')[0]).toBe('/session/ses_lost_drop/message/msg_0a1b2c3d4e5fAbCdEf01234567')
  expect(check?.path).toContain('directory=%2Fpath')
  second.answer(check!, 200, stored('ses_lost_drop', 'msg_0a1b2c3d4e5fAbCdEf01234567'))

  const res = await view
  expect(res.status).toBe(204)
  // Never re-posted.
  expect(await second.next(800)).toBeUndefined()
  second.ws.terminate()
}, 15_000)

test('a prompt caught by a socket the bridge replaced is checked on the new socket at once', async () => {
  // The bridge can notice a dead link before the relay does and re-dial, so
  // the relay replaces a socket it still counts as open instead of seeing it
  // close. Nothing ever answers what was sent into that socket, and the viewer
  // used to wait out the whole prompt timeout (two minutes in production)
  // before the check that finds the prompt even started.
  const savedPromptTimeout = process.env.RELAY_PROMPT_TIMEOUT_MS
  process.env.RELAY_PROMPT_TIMEOUT_MS = '30000'
  try {
    const { bridgeToken, viewerToken } = await share('ses_lost_replaced')
    const first = await bridgeSocket('ses_lost_replaced', bridgeToken)
    const view = request(relay)
      .post('/session/ses_lost_replaced/prompt_async')
      .set('x-viewer-token', viewerToken)
      .send(prompt('msg_0a1b2c3d4e5fAbCdEf01234567'))
      .then((r) => r)

    expect((await first.next())?.method).toBe('POST')
    // opencode took it; the bridge gives up on the link and dials again while
    // the relay still holds the old socket open.
    const replacedAt = Date.now()
    const second = await bridgeSocket('ses_lost_replaced', bridgeToken)
    const check = await second.next(3000)
    expect(check?.method).toBe('GET')
    expect(check?.path.split('?')[0]).toBe('/session/ses_lost_replaced/message/msg_0a1b2c3d4e5fAbCdEf01234567')
    second.answer(check!, 200, stored('ses_lost_replaced', 'msg_0a1b2c3d4e5fAbCdEf01234567'))

    expect((await view).status).toBe(204)
    expect(Date.now() - replacedAt).toBeLessThan(5000)
    // Never re-posted, on either socket.
    expect(await second.next(800)).toBeUndefined()
    expect(await first.next(0)).toBeUndefined()
    second.ws.terminate()
  } finally {
    if (savedPromptTimeout === undefined) delete process.env.RELAY_PROMPT_TIMEOUT_MS
    else process.env.RELAY_PROMPT_TIMEOUT_MS = savedPromptTimeout
  }
}, 15_000)

test('the same prompt still fails when opencode has no such message', async () => {
  const { bridgeToken, viewerToken } = await share('ses_lost_none')
  const first = await bridgeSocket('ses_lost_none', bridgeToken)
  const view = request(relay)
    .post('/session/ses_lost_none/prompt_async')
    .set('x-viewer-token', viewerToken)
    .send(prompt('msg_0a1b2c3d4e5fAbCdEf01234567'))
    .then((r) => r)

  expect((await first.next())?.method).toBe('POST')
  first.ws.terminate()
  await new Promise((resolve) => setTimeout(resolve, 300))

  const second = await bridgeSocket('ses_lost_none', bridgeToken)
  const check = await second.next()
  expect(check?.method).toBe('GET')
  second.answer(check!, 404, { name: 'NotFoundError', data: { message: 'Message not found' } })

  const res = await view
  expect(res.status).toBe(502)
  expect(res.body).toEqual({ error: 'proxy failed' })
  expect(await second.next(800)).toBeUndefined()
  second.ws.terminate()
}, 15_000)

test('a 200 for some other message is not proof the prompt landed', async () => {
  const { bridgeToken, viewerToken } = await share('ses_lost_other')
  const first = await bridgeSocket('ses_lost_other', bridgeToken)
  const view = request(relay)
    .post('/session/ses_lost_other/prompt_async')
    .set('x-viewer-token', viewerToken)
    .send(prompt('msg_0a1b2c3d4e5fAbCdEf01234567'))
    .then((r) => r)

  await first.next()
  first.ws.terminate()
  const second = await bridgeSocket('ses_lost_other', bridgeToken)
  const check = await second.next()
  second.answer(check!, 200, stored('ses_somebody_else', 'msg_0a1b2c3d4e5fAbCdEf01234567'))

  expect((await view).status).toBe(502)
  second.ws.terminate()
}, 15_000)

test('a prompt without a well-formed messageID keeps the plain 502', async () => {
  for (const [i, messageID] of [undefined, 'msg_x/../../../config'].entries()) {
    const session_id = `ses_lost_noid${i}`
    const { bridgeToken, viewerToken } = await share(session_id)
    const first = await bridgeSocket(session_id, bridgeToken)
    const view = request(relay)
      .post(`/session/${session_id}/prompt_async`)
      .set('x-viewer-token', viewerToken)
      .send(prompt(messageID))
      .then((r) => r)

    expect((await first.next())?.method).toBe('POST')
    first.ws.terminate()
    const res = await view
    expect({ messageID, status: res.status }).toEqual({ messageID, status: 502 })

    // Nothing follows the bridge back: no check, no second POST.
    const second = await bridgeSocket(session_id, bridgeToken)
    expect(await second.next(800)).toBeUndefined()
    second.ws.terminate()
  }
}, 15_000)

test('a prompt that never left the relay fails at once', async () => {
  const { viewerToken } = await share('ses_lost_never')
  const started = Date.now()
  const res = await request(relay)
    .post('/session/ses_lost_never/prompt_async')
    .set('x-viewer-token', viewerToken)
    .send(prompt('msg_0a1b2c3d4e5fAbCdEf01234567'))
  expect(res.status).toBe(502)
  expect(res.body).toEqual({ error: 'bridge not connected' })
  expect(Date.now() - started).toBeLessThan(500)
})

test('a prompt whose answer is late past the prompt timeout is reported accepted once opencode has the message', async () => {
  const { bridgeToken, viewerToken } = await share('ses_lost_slow')
  const bridge = await bridgeSocket('ses_lost_slow', bridgeToken)
  const started = Date.now()
  const view = request(relay)
    .post('/session/ses_lost_slow/prompt_async')
    .set('x-viewer-token', viewerToken)
    .send(prompt('msg_0a1b2c3d4e5fAbCdEf01234567'))
    .then((r) => r)

  // Received, and its 204 is stuck behind the uplink: never answered.
  expect((await bridge.next())?.method).toBe('POST')
  const check = await bridge.next(5000)
  expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  expect(check?.method).toBe('GET')
  expect(check?.path.split('?')[0]).toBe('/session/ses_lost_slow/message/msg_0a1b2c3d4e5fAbCdEf01234567')
  bridge.answer(check!, 200, stored('ses_lost_slow', 'msg_0a1b2c3d4e5fAbCdEf01234567'))

  expect((await view).status).toBe(204)
  expect(await bridge.next(800)).toBeUndefined()
  bridge.ws.terminate()
}, 15_000)

test('a timed-out prompt opencode never got is still a 504', async () => {
  const { bridgeToken, viewerToken } = await share('ses_lost_timeout')
  const bridge = await bridgeSocket('ses_lost_timeout', bridgeToken)
  const view = request(relay)
    .post('/session/ses_lost_timeout/prompt_async')
    .set('x-viewer-token', viewerToken)
    .send(prompt('msg_0a1b2c3d4e5fAbCdEf01234567'))
    .then((r) => r)

  await bridge.next()
  const check = await bridge.next(5000)
  bridge.answer(check!, 404, { name: 'NotFoundError' })
  const res = await view
  expect(res.status).toBe(504)
  expect(res.body).toEqual({ error: 'proxy timeout' })
  bridge.ws.terminate()
}, 15_000)

test('a prompt is not held to the ordinary proxy timeout', async () => {
  // opencode answers a prompt in milliseconds; the rest is the owner's uplink,
  // and a 204 that is on its way must be allowed to arrive.
  ;(config as { proxyTimeoutMs: number }).proxyTimeoutMs = 200
  const { bridgeToken, viewerToken } = await share('ses_lost_patient')
  const bridge = await bridgeSocket('ses_lost_patient', bridgeToken)
  const view = request(relay)
    .post('/session/ses_lost_patient/prompt_async')
    .set('x-viewer-token', viewerToken)
    .send(prompt('msg_0a1b2c3d4e5fAbCdEf01234567'))
    .then((r) => r)

  const sent = await bridge.next()
  await new Promise((resolve) => setTimeout(resolve, 500))
  bridge.answer(sent!, 204, undefined)
  expect((await view).status).toBe(204)
  bridge.ws.terminate()
}, 15_000)
