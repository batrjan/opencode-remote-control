import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * Events opencode emits while the bridge's link to the relay is down.
 *
 * The bridge keeps reading opencode's /event stream through an outage and has
 * nowhere to put what it reads, so every event of that window is gone — and on
 * a flaky owner uplink a keep-alive kill can take ~40 s to notice a dead link.
 * Nothing told the viewer. The relay kept sending its own heartbeats through the
 * gap, never re-sent `server.connected`, and the web UI has no way to notice a
 * hole on its own: it drops a part whose message it never saw, so a message
 * started during the outage showed up at the end with no text at all, a session
 * that went busy during it looked busy forever, and a permission prompt raised
 * in it never appeared. Only a page reload recovered.
 *
 * When a bridge re-dials, the relay now re-sends the handshake (the UI then
 * reloads session status, permissions and questions) and replays the latest
 * messages as the events the UI already applies.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
// A bridge that re-dials quickly, but not before the outage events are read.
process.env.REMOTE_CONTROL_RECONNECT_BASE_MS = '500'
process.env.REMOTE_CONTROL_RECONNECT_MAX_MS = '600'

type Item = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> }

let relay: http.Server
let relayUrl: string
let hub: BridgeClient
let opencode: http.Server
let opencodeUrl: string
/** Open opencode /event subscriptions (one per bridge). */
let eventStreams: Set<http.ServerResponse>
/** What GET /session/:id/message answers, per session. */
let transcript: Map<string, Item[]>
let messageFetches: URL[]
const cleanup: Array<() => void> = []

beforeEach(async () => {
  eventStreams = new Set()
  transcript = new Map()
  messageFetches = []
  opencode = http.createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"type":"server.connected","properties":{}}\n\n')
      eventStreams.add(res)
      res.on('close', () => eventStreams.delete(res))
      return
    }
    const m = /^\/session\/([^/]+)\/message$/.exec(url.pathname)
    if (req.method === 'GET' && m) {
      messageFetches.push(url)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(transcript.get(m[1]!) ?? []))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`

  const store = new Store()
  relay = http.createServer()
  hub = new BridgeClient(relay, store)
  relay.on('request', createApp(store, hub))
  relay.on('close', () => hub.close())
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterEach(async () => {
  for (const fn of cleanup.splice(0)) fn()
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(10)
  }
  return cond()
}

async function share(session_id: string) {
  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id, directory: '/w', title: 'gap' })
  expect(created.status).toBe(201)
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id })
  return { bridgeToken: created.body.bridge_token as string, viewerToken: activated.body.viewer_token as string }
}

/** A real bridge process-in-miniature, forwarding the fake opencode's events. */
async function realBridge(session_id: string, bridgeToken: string) {
  const bridge = new RelayWSClient(relayUrl, new OpencodeClient(opencodeUrl, 'opencode', ''))
  let reconnects = 0
  bridge.onReconnect = () => {
    reconnects += 1
  }
  await bridge.connect(session_id, bridgeToken, '/w')
  await bridge.startEventForwarding()
  cleanup.push(() => bridge.close())
  return {
    reconnects: () => reconnects,
    /** The link dies under the bridge (what a keep-alive kill looks like). */
    dropLink: () => (bridge as unknown as { ws: WebSocket }).ws.terminate(),
  }
}

type Frame = { payload: { type: string; properties?: Record<string, any> }; hasDirectory: boolean }

/** The web UI's /global/event stream, parsed into frames. */
async function viewer(viewerToken: string) {
  const controller = new AbortController()
  cleanup.push(() => controller.abort())
  const res = await fetch(`${relayUrl}/global/event`, {
    headers: { 'x-viewer-token': viewerToken },
    signal: controller.signal,
  })
  expect(res.status).toBe(200)
  const frames: Frame[] = []
  const state = { ended: false }
  void (async () => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let i: number
        while ((i = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, i)
          buffer = buffer.slice(i + 2)
          const data = chunk
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n')
          if (!data) continue
          const parsed = JSON.parse(data)
          frames.push({ payload: parsed.payload, hasDirectory: 'directory' in parsed })
        }
      }
    } catch {
      // aborted by cleanup
    }
    state.ended = true
  })()
  const ids = (type: string) =>
    frames
      .filter((f) => f.payload.type === type)
      .map((f) => (type === 'message.updated' ? f.payload.properties?.info?.id : f.payload.properties?.part?.id))
  return { frames, state, ids, handshakes: () => frames.filter((f) => f.payload.type === 'server.connected') }
}

function push(event: unknown) {
  for (const res of eventStreams) res.write(`data: ${JSON.stringify(event)}\n\n`)
}

const info = (id: string, sessionID: string, role = 'assistant') => ({ id, sessionID, role, time: { created: 1 } })
const part = (id: string, messageID: string, sessionID: string, text = `text of ${id}`) => ({
  id,
  messageID,
  sessionID,
  type: 'text',
  text,
})

test('the hub reports a bridge re-dial, and never a first connection', async () => {
  const { bridgeToken } = await share('ses_gap_hook')
  const seen: string[] = []
  hub.onReconnect((session_id) => seen.push(session_id))
  const dial = async () => {
    const ws = new WebSocket(`${relayUrl.replace(/^http/, 'ws')}/bridge?session_id=ses_gap_hook`, {
      headers: { 'x-bridge-token': bridgeToken },
    })
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    cleanup.push(() => ws.terminate())
    return ws
  }

  const first = await dial()
  await sleep(100)
  expect(seen).toEqual([])

  // The link drops and the bridge comes back.
  first.terminate()
  expect(await waitFor(() => !hub.isConnected('ses_gap_hook'))).toBe(true)
  await dial()
  expect(await waitFor(() => seen.length === 1)).toBe(true)
  expect(seen).toEqual(['ses_gap_hook'])

  // The bridge noticed the dead link before the relay did: its new socket
  // replaces one the relay still thinks is open. Events were lost all the same.
  await dial()
  expect(await waitFor(() => seen.length === 2)).toBe(true)
  expect(seen).toEqual(['ses_gap_hook', 'ses_gap_hook'])
})

test('a viewer gets the events it missed while the bridge link was down', async () => {
  const A = 'ses_gap_a'
  const B = 'ses_gap_b'
  const shareA = await share(A)
  const shareB = await share(B)
  const bridgeA = await realBridge(A, shareA.bridgeToken)
  await realBridge(B, shareB.bridgeToken)
  expect(await waitFor(() => eventStreams.size === 2)).toBe(true)
  const viewerA = await viewer(shareA.viewerToken)
  const viewerB = await viewer(shareB.viewerToken)
  transcript.set(B, [{ info: info('msg_b1', B), parts: [part('prt_b1', 'msg_b1', B)] }])

  // Live, before the outage: both reach viewer A.
  transcript.set(A, [
    { info: info('msg_0', A, 'user'), parts: [part('prt_0', 'msg_0', A)] },
    { info: info('msg_A', A), parts: [part('prt_A1', 'msg_A', A)] },
  ])
  push({ type: 'message.updated', properties: { sessionID: A, info: info('msg_A', A) } })
  push({ type: 'message.part.updated', properties: { part: part('prt_A1', 'msg_A', A) } })
  expect(await waitFor(() => viewerA.ids('message.part.updated').includes('prt_A1'))).toBe(true)

  // The link drops; opencode keeps working and the bridge reads into the void.
  bridgeA.dropLink()
  expect(await waitFor(() => !hub.isConnected(A))).toBe(true)
  transcript.get(A)!.push({ info: info('msg_B', A), parts: [part('prt_B1', 'msg_B', A)] })
  // An answer carrying someone else's message must not leak into the replay.
  transcript.get(A)!.push({ info: info('msg_foreign', B), parts: [part('prt_foreign', 'msg_foreign', B)] })
  push({ type: 'message.updated', properties: { sessionID: A, info: info('msg_B', A) } })
  push({ type: 'message.part.updated', properties: { part: part('prt_B1', 'msg_B', A) } })
  push({ type: 'session.status', properties: { sessionID: A, status: { type: 'busy' } } })
  expect(bridgeA.reconnects()).toBe(0)

  expect(await waitFor(() => bridgeA.reconnects() === 1, 5000)).toBe(true)

  // The handshake again, shaped like opencode's own (no directory, so the UI
  // takes it as the global event that reloads status and permissions).
  expect(await waitFor(() => viewerA.handshakes().length === 2, 2000)).toBe(true)
  expect(viewerA.handshakes().every((f) => !f.hasDirectory)).toBe(true)
  // The missed message and its part, as the events the UI applies.
  expect(await waitFor(() => viewerA.ids('message.part.updated').includes('prt_B1'), 2000)).toBe(true)
  expect(viewerA.ids('message.updated')).toContain('msg_B')
  const replayed = viewerA.frames.find((f) => f.payload.properties?.info?.id === 'msg_B')!
  expect(replayed.hasDirectory).toBe(true)
  expect(replayed.payload.properties?.sessionID).toBe(A)
  // Asked for with the session's own directory, like every proxied read.
  const fetched = messageFetches.find((u) => u.pathname === `/session/${A}/message`)
  expect(fetched?.searchParams.get('directory')).toBe('/w')
  expect(Number(fetched?.searchParams.get('limit'))).toBeGreaterThanOrEqual(20)

  await sleep(300)
  expect(viewerA.ids('message.updated')).not.toContain('msg_foreign')
  expect(viewerA.ids('message.part.updated')).not.toContain('prt_foreign')
  // The viewer's stream stays open: closing it would land the replay inside
  // the UI's reconnect window.
  expect(viewerA.state.ended).toBe(false)
  // The other share's viewer saw none of it, and no handshake of its own.
  expect(viewerB.handshakes().length).toBe(1)
  expect(viewerB.ids('message.updated')).toEqual([])
  expect(viewerB.ids('message.part.updated')).toEqual([])
  expect(messageFetches.some((u) => u.pathname === `/session/${B}/message`)).toBe(false)
}, 20_000)

test('a replay larger than the viewer buffer cap reaches a reading viewer without dropping it', async () => {
  // Transcripts are big (tool output, file diffs): written in one burst, the
  // replay would trip the stuck-viewer cap and destroy every viewer's stream.
  const previousCap = process.env.RELAY_SSE_MAX_BUFFER_BYTES
  process.env.RELAY_SSE_MAX_BUFFER_BYTES = String(64 * 1024)
  cleanup.push(() => {
    if (previousCap === undefined) delete process.env.RELAY_SSE_MAX_BUFFER_BYTES
    else process.env.RELAY_SSE_MAX_BUFFER_BYTES = previousCap
  })
  const S = 'ses_gap_big'
  const { bridgeToken, viewerToken } = await share(S)
  const bridge = await realBridge(S, bridgeToken)
  expect(await waitFor(() => eventStreams.size === 1)).toBe(true)
  const view = await viewer(viewerToken)

  bridge.dropLink()
  expect(await waitFor(() => !hub.isConnected(S))).toBe(true)
  // ~1.2 MB of random part text, some 19 times the cap.
  const parts = Array.from({ length: 100 }, (_, i) =>
    part(`prt_big_${String(i).padStart(3, '0')}`, 'msg_big', S, randomBytes(9000).toString('base64')),
  )
  transcript.set(S, [{ info: info('msg_big', S), parts }])
  expect(await waitFor(() => bridge.reconnects() === 1, 5000)).toBe(true)

  expect(await waitFor(() => view.ids('message.part.updated').length === parts.length, 8000)).toBe(true)
  expect(view.state.ended).toBe(false)
}, 20_000)
