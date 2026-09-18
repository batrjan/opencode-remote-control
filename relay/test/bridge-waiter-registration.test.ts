import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'
import { viewerTokenFrom } from './helpers/viewer-token'

/**
 * A viewer request waiting for a bridge to re-dial belongs to the registration
 * its viewer joined, not to whoever holds the session id when a bridge dials in.
 *
 * A GET caught by a dropped link waits (up to bridgeReconnectWaitMs) for the
 * session's bridge to come back, and a prompt whose answer was lost waits the
 * same way before asking opencode whether the message landed. The viewer was
 * checked before the wait; the wait itself was keyed by session id alone. So an
 * owner on an older bridge (no owner_key) whose uplink dropped, and who then
 * stopped the share over HTTP, freed the id with the viewer's request still
 * waiting — and when anyone holding the link registered the id and connected a
 * bridge, the request was sent there: path, the owner's project directory in
 * the query, and the answer that bridge chose went back to the viewer as 200.
 * A lost prompt was looked up on that bridge too, and reported as delivered on
 * its word. Stopping the share (bridge.disconnect() with no socket) also left
 * the waiters and the re-dial mark behind for the id's next registration.
 *
 * Harness: createApp + BridgeClient over one ephemeral server, raw ws clients
 * as the bridges, so the test can also end a registration in the store alone —
 * as the full relay's eviction does, without telling the bridge hub.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'
process.env.RELAY_BRIDGE_RECONNECT_WAIT_MS = '2000'

// Documentation addresses (RFC 5737), one per party.
const OWNER_IP = '198.51.100.7'
const NEXT_IP = '203.0.113.9'
const MESSAGE_ID = 'msg_0a1b2c3d4e5fAbCdEf01234567'

let server: http.Server
let store: Store
let bridge: BridgeClient
let base: string
const sockets: WebSocket[] = []

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  store = new Store()
  server = http.createServer()
  bridge = new BridgeClient(server, store)
  server.on('request', createApp(store, bridge))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ws of sockets.splice(0)) ws.terminate()
  bridge.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const http_ = () => request(`http://${base}`)

/** Registers like an older bridge: no owner_key, so the id is free once the share ends. */
async function register(session_id: string, ip: string, directory: string) {
  const res = await http_().post('/api/sessions').set('X-Forwarded-For', ip).send({ session_id, directory, title: 't' })
  expect(res.status).toBe(201)
  return res.body as { access_code: string; bridge_token: string }
}

async function join(session_id: string, code: string): Promise<string> {
  const res = await http_().post('/api/activate').send({ code, session_id })
  expect(res.status).toBe(200)
  return viewerTokenFrom(res)
}

type Proxy = { request_id: string; method: string; path: string }

/**
 * A hand-driven bridge socket. `seen` records every proxy request it is sent;
 * with `answerAll` it answers each at once, the way a bridge that wants the
 * viewer's traffic would: a stored copy of any message asked about, and its
 * own content for anything else.
 */
async function bridgeSocket(session_id: string, token: string, answerAll = false) {
  const ws = new WebSocket(`ws://${base}/bridge?session_id=${encodeURIComponent(session_id)}`, {
    headers: { 'x-bridge-token': token },
  })
  sockets.push(ws)
  const seen: Proxy[] = []
  const queue: Proxy[] = []
  const answer = (p: Proxy, body: unknown) =>
    ws.send(
      JSON.stringify({ type: 'proxy_response', request_id: p.request_id, status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
    )
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw))
    if (msg.type !== 'proxy') return
    seen.push(msg)
    if (!answerAll) {
      queue.push(msg)
      return
    }
    const lookup = /^\/session\/([^/?]+)\/message\/([^/?]+)/.exec(msg.path)
    answer(
      msg,
      lookup
        ? { info: { id: decodeURIComponent(lookup[2]), sessionID: decodeURIComponent(lookup[1]), role: 'user' }, parts: [] }
        : 'content chosen by the next registrant',
    )
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const next = async (ms = 3000) => {
    const deadline = Date.now() + ms
    while (queue.length === 0) {
      if (Date.now() > deadline) return undefined
      await settle(10)
    }
    return queue.shift()
  }
  return { ws, seen, next, answer }
}

/** How the owner's share ends while the viewer's request waits. */
const endings: Array<[string, (session_id: string, bridgeToken: string) => Promise<void>]> = [
  [
    'stopped by its owner over HTTP',
    async (session_id, bridgeToken) => {
      const res = await http_().delete(`/api/sessions/${session_id}`).set('x-bridge-token', bridgeToken)
      expect(res.status).toBe(204)
    },
  ],
  [
    'ended in the store without a word to the bridge hub',
    async (session_id) => {
      expect(store.deleteSession(session_id)).toBe(true)
    },
  ],
]

test.each(endings)('a GET waiting out a re-dial is never sent to the next registration of the id (share %s)', async (_, end) => {
  const id = 'ses_waiter_get'
  const owner = await register(id, OWNER_IP, '/owner/secret-project')
  const viewer = await join(id, owner.access_code)
  const ownerLink = await bridgeSocket(id, owner.bridge_token)
  // The owner's uplink drops; the viewer's UI reads a file meanwhile, and the
  // GET waits for the bridge to re-dial.
  ownerLink.ws.terminate()
  await settle(200)
  const read = http_().get('/file/content?path=src/keys.ts').set('x-viewer-token', viewer).then((r) => r)
  await settle(200)

  await end(id, owner.bridge_token)
  // Someone holding the link registers the freed id and connects a bridge.
  const next = await register(id, NEXT_IP, '/elsewhere')
  const nextLink = await bridgeSocket(id, next.bridge_token, true)

  const res = await read
  expect(res.status).toBe(502)
  expect(res.text).not.toContain('next registrant')
  await settle(300)
  expect(nextLink.seen.map((p) => `${p.method} ${p.path}`)).toEqual([])
}, 15_000)

test.each(endings)("a prompt's lost answer is never looked up on the next registration's bridge (share %s)", async (_, end) => {
  const id = 'ses_waiter_prompt'
  const owner = await register(id, OWNER_IP, '/owner/secret-project')
  const viewer = await join(id, owner.access_code)
  const ownerLink = await bridgeSocket(id, owner.bridge_token)
  const send = http_()
    .post(`/session/${id}/prompt_async`)
    .set('x-viewer-token', viewer)
    .send({ messageID: MESSAGE_ID, parts: [{ type: 'text', text: 'run the migration once' }] })
    .then((r) => r)
  expect((await ownerLink.next())?.method).toBe('POST')
  // The link drops before the 204 gets back: the relay waits for the re-dial
  // to ask opencode whether the message landed.
  ownerLink.ws.terminate()
  await settle(200)

  await end(id, owner.bridge_token)
  const next = await register(id, NEXT_IP, '/elsewhere')
  const nextLink = await bridgeSocket(id, next.bridge_token, true)

  const res = await send
  // Not "delivered" on the word of a bridge that never saw the prompt.
  expect(res.status).toBe(502)
  await settle(300)
  expect(nextLink.seen.map((p) => `${p.method} ${p.path}`)).toEqual([])
}, 15_000)

test('a GET waiting out a re-dial is still answered when its own registration re-dials', async () => {
  const id = 'ses_waiter_same'
  const owner = await register(id, OWNER_IP, '/owner/project')
  const viewer = await join(id, owner.access_code)
  const first = await bridgeSocket(id, owner.bridge_token)
  first.ws.terminate()
  await settle(200)
  const read = http_().get('/file/content?path=src/app.ts').set('x-viewer-token', viewer).then((r) => r)
  await settle(200)

  const second = await bridgeSocket(id, owner.bridge_token)
  const sent = await second.next()
  expect(sent?.path.split('?')[0]).toBe('/file/content')
  second.answer(sent!, { type: 'text', content: 'export {}' })

  const res = await read
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ type: 'text', content: 'export {}' })
}, 15_000)

test("stopping a share fails its waiting requests at once, and the id's next registration inherits no re-dial", async () => {
  const id = 'ses_waiter_stop'
  const owner = await register(id, OWNER_IP, '/owner/project')
  const viewer = await join(id, owner.access_code)
  const link = await bridgeSocket(id, owner.bridge_token)
  link.ws.terminate()
  await settle(200)
  const read = http_().get('/file/content?path=src/app.ts').set('x-viewer-token', viewer).then((r) => r)
  await settle(200)

  const del = await http_().delete(`/api/sessions/${id}`).set('x-bridge-token', owner.bridge_token)
  expect(del.status).toBe(204)
  const stoppedAt = Date.now()
  expect((await read).status).toBe(502)
  // Not the rest of the 2 s wait for a bridge whose share no longer exists.
  expect(Date.now() - stoppedAt).toBeLessThan(1000)

  // The next share of the id has never had a bridge: its viewer fails fast, as
  // on any share whose bridge has not connected yet, rather than waiting for a
  // "re-dial" that was the previous registration's.
  const next = await register(id, NEXT_IP, '/elsewhere')
  const nextViewer = await join(id, next.access_code)
  const asked = Date.now()
  expect((await http_().get('/file/content?path=a.ts').set('x-viewer-token', nextViewer)).status).toBe(502)
  expect(Date.now() - asked).toBeLessThan(1000)
}, 15_000)
