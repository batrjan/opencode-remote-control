import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { WebSocket } from 'ws'
import { shutdown, startServer } from '../src/server'

/**
 * A viewer request that arrives while the owner's bridge is re-dialling a
 * relay that has just been restarted.
 *
 * A GET caught by a bridge re-dial waits for the bridge to come back (see
 * bridge-reconnect-retry.test.ts) — but only if the relay remembers the drop,
 * and that memory lived in the process. A redeploy restores every session and
 * viewer token from the state file, yet the new process had never seen those
 * bridges, so it took them for bridges that were never there and failed every
 * viewer GET at once with 502 "bridge not connected". The bridge cannot come
 * back the moment the relay does: each refused dial during the downtime
 * doubled its backoff, so its next attempt landed seconds after the relay was
 * up (3-4 s, measured with the real bridge client). A tab reconnecting its
 * event stream to the new relay refetches at exactly that moment, and every
 * one of those requests was an error.
 *
 * A restored session's bridge is now expected back, like one whose link the
 * relay saw drop.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY

let dir: string
const cleanup: Array<() => void | Promise<void>> = []

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'relay-restart-retry-'))
  process.env.RELAY_STATE_FILE = path.join(dir, 'sessions.json')
  process.env.RELAY_BRIDGE_RECONNECT_WAIT_MS = '5000' // the production default
})

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  delete process.env.RELAY_STATE_FILE
  delete process.env.RELAY_BRIDGE_RECONNECT_WAIT_MS
  rmSync(dir, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(10)
  }
  return cond()
}

async function start(port = 0): Promise<{ relay: Server; url: string }> {
  const relay = await startServer(port)
  cleanup.push(async () => {
    if (!relay.listening) return
    relay.closeAllConnections()
    await new Promise((resolve) => relay.close(resolve))
  })
  return { relay, url: `http://127.0.0.1:${(relay.address() as AddressInfo).port}` }
}

async function share(relay: Server, session_id: string) {
  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id, directory: '/work', title: 'restart' })
  expect(created.status).toBe(201)
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id })
  expect(activated.status).toBe(200)
  return { bridgeToken: created.body.bridge_token as string, viewerToken: activated.body.viewer_token as string }
}

/** A hand-driven bridge socket that answers every proxy request with 200 []. */
async function bridgeSocket(url: string, session_id: string, bridgeToken: string) {
  const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/bridge?session_id=${session_id}`, {
    headers: { 'x-bridge-token': bridgeToken },
  })
  const proxied: string[] = []
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return
    const msg = JSON.parse(String(raw))
    if (msg.type !== 'proxy') return
    proxied.push(msg.path)
    ws.send(JSON.stringify({ type: 'proxy_response', request_id: msg.request_id, status: 200, contentType: 'application/json', body: '[]' }))
  })
  ws.on('error', () => {})
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  cleanup.push(() => ws.terminate())
  return { ws, proxied }
}

/**
 * Redeploy: the old relay goes through the signal handler's shutdown() and a
 * new one comes up on the same port with the same state file. A bridge socket
 * keeps close() pending (index.ts exits on a deadline instead); here the link
 * is torn down the way the old process's exit tears it down.
 */
async function restart(relay: Server, link: WebSocket): Promise<Server> {
  const port = (relay.address() as AddressInfo).port
  const closed = shutdown(relay)
  link.terminate()
  await closed
  return (await start(port)).relay
}

async function viewerGet(relay: Server, session_id: string, viewerToken: string) {
  const started = Date.now()
  const res = await request(relay).get(`/session/${session_id}/message`).set('x-viewer-token', viewerToken)
  return { status: res.status, body: res.body as unknown, ms: Date.now() - started }
}

test('a GET on a restored share waits for its bridge to re-dial the new relay', async () => {
  const { relay: first, url } = await start()
  const { bridgeToken, viewerToken } = await share(first, 'ses_restart_get')
  const link = await bridgeSocket(url, 'ses_restart_get', bridgeToken)
  expect((await viewerGet(first, 'ses_restart_get', viewerToken)).status).toBe(200)

  const relay = await restart(first, link.ws)
  // The share and the viewer's token came through the restart...
  const presence = await request(relay).get('/api/sessions/ses_restart_get')
  expect(presence.status).toBe(200)
  expect(presence.body.bridge_connected).toBe(false)

  // ...and the viewer's request arrives before the bridge's next dial does.
  const pending = viewerGet(relay, 'ses_restart_get', viewerToken)
  await sleep(800)
  const back = await bridgeSocket(url, 'ses_restart_get', bridgeToken)
  const out = await pending
  expect(out.status).toBe(200)
  expect(out.body).toEqual([])
  expect(out.ms).toBeGreaterThanOrEqual(700)
  expect(back.proxied.some((p) => p.startsWith('/session/ses_restart_get/message'))).toBe(true)
}, 15_000)

test('a GET on a restored share whose bridge never comes back still ends in 502', async () => {
  process.env.RELAY_BRIDGE_RECONNECT_WAIT_MS = '300'
  const { relay: first, url } = await start()
  const { bridgeToken, viewerToken } = await share(first, 'ses_restart_gone')
  const link = await bridgeSocket(url, 'ses_restart_gone', bridgeToken)

  const relay = await restart(first, link.ws)
  const out = await viewerGet(relay, 'ses_restart_gone', viewerToken)
  expect(out.status).toBe(502)
  expect(out.body).toEqual({ error: 'bridge not connected' })
  // Held for the reconnect wait, not for good.
  expect(out.ms).toBeGreaterThanOrEqual(250)
  expect(out.ms).toBeLessThan(3000)
}, 15_000)

test("the bridge's first dial to the new relay catches open viewers up", async () => {
  // Everything opencode emitted while no relay was listening is lost, exactly
  // as in a link drop, so the viewers get the same resync.
  const { relay: first, url } = await start()
  const { bridgeToken, viewerToken } = await share(first, 'ses_restart_resync')
  const link = await bridgeSocket(url, 'ses_restart_resync', bridgeToken)

  await restart(first, link.ws)
  // The tab's event stream reconnects to the new relay before the bridge does.
  const controller = new AbortController()
  cleanup.push(() => controller.abort())
  const stream = await fetch(`${url}/global/event`, { headers: { 'x-viewer-token': viewerToken }, signal: controller.signal })
  expect(stream.status).toBe(200)
  void stream.body!.pipeTo(new WritableStream()).catch(() => {})

  const back = await bridgeSocket(url, 'ses_restart_resync', bridgeToken)
  expect(await waitFor(() => back.proxied.some((p) => p.startsWith('/session/ses_restart_resync/message?limit=')))).toBe(true)
}, 15_000)
