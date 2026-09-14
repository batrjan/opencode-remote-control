import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * A viewer's open event stream must end with the registration it was opened
 * on, not a heartbeat later.
 *
 * The stream authenticates once, at open, and is subscribed to the bridge's
 * events by session id. Revocation used to reach it only through the
 * heartbeat's re-check (every 15 s by default). The ends of a share revoke the
 * token at once, but an owner's replacement of its own registration (owner_key)
 * has the new bridge dial in within a second or so, under the SAME id, and a
 * delete or reap followed by a new share of the same conversation does the
 * same. Until the next beat, every viewer of the previous share, whose token
 * was just revoked, received the new share's live events on the stream it held.
 *
 * The heartbeat is set far beyond the test's length here, so only the end of
 * the registration itself can close the stream. Harness: createApp +
 * BridgeClient over one ephemeral server, raw ws clients as the bridges.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'
process.env.RELAY_SSE_HEARTBEAT_MS = '600000'

const OWNER_IP = '198.51.100.7'

let server: http.Server
let store: Store
let bridge: BridgeClient
let base: string
const sockets: WebSocket[] = []
const streams: AbortController[] = []

beforeEach(async () => {
  store = new Store()
  server = http.createServer()
  bridge = new BridgeClient(server, store)
  server.on('request', createApp(store, bridge))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ac of streams.splice(0)) ac.abort()
  for (const ws of sockets.splice(0)) ws.terminate()
  bridge.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function register(session_id: string, owner_key?: string) {
  const res = await fetch(`http://${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': OWNER_IP },
    body: JSON.stringify({ session_id, directory: '/owner/project', title: 't', ...(owner_key ? { owner_key } : {}) }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { access_code: string; bridge_token: string }
}

/** A bridge that only pushes events. */
async function connectBridge(session_id: string, token: string) {
  const ws = new WebSocket(`ws://${base}/bridge?session_id=${encodeURIComponent(session_id)}`, {
    headers: { 'x-bridge-token': token },
  })
  sockets.push(ws)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return {
    emit: (event: unknown) => ws.send(JSON.stringify({ type: 'event', data: JSON.stringify(event) })),
  }
}

/** A viewer's /event stream: the raw text it received, and whether the relay ended it. */
async function openStream(viewerToken: string) {
  const ac = new AbortController()
  streams.push(ac)
  const res = await fetch(`http://${base}/event`, { headers: { 'x-viewer-token': viewerToken }, signal: ac.signal })
  expect(res.status).toBe(200)
  const state = { text: '', ended: false }
  void (async () => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        state.text += decoder.decode(value, { stream: true })
      }
    } catch {
      // aborted by the test
    } finally {
      state.ended = true
    }
  })()
  return state
}

/** An event of the shared session, carrying a marker to look for. */
const statusEvent = (session_id: string, marker: string) => ({
  type: 'session.status',
  properties: { sessionID: session_id, status: { type: 'busy' }, marker },
})

/** Polls until `check` holds or `ms` pass; returns whether it held. */
async function eventually(check: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await settle(20)
  return check()
}

/**
 * A live share with one viewer whose stream is proven to carry the share's
 * events, so an absent marker later means the stream stopped, not that it
 * never worked.
 */
async function liveShare(session_id: string, owner_key?: string) {
  const first = await register(session_id, owner_key)
  const oldBridge = await connectBridge(session_id, first.bridge_token)
  const { viewer_token } = store.activate(first.access_code, session_id)
  const stream = await openStream(viewer_token)
  await settle(50)
  oldBridge.emit(statusEvent(session_id, 'first-share'))
  expect(await eventually(() => stream.text.includes('first-share'))).toBe(true)
  return { first, stream }
}

test("an owner's replacement of its registration ends the old share's viewer streams before the new bridge speaks", async () => {
  const K = randomBytes(32).toString('base64url')
  const { stream } = await liveShare('ses_endreplace1', K)

  // The owner's bridge died without a word and starts again.
  const second = await register('ses_endreplace1', K)
  const newBridge = await connectBridge('ses_endreplace1', second.bridge_token)
  newBridge.emit(statusEvent('ses_endreplace1', 'second-share'))
  await settle(200)
  expect(stream.text).not.toContain('second-share')
  expect(stream.ended).toBe(true)
})

test('a delete ends the share viewer streams, so a later share of the same session never reaches them', async () => {
  const K = randomBytes(32).toString('base64url')
  const { first, stream } = await liveShare('ses_enddelete1', K)

  const deleted = await fetch(`http://${base}/api/sessions/ses_enddelete1`, {
    method: 'DELETE',
    headers: { 'x-bridge-token': first.bridge_token },
  })
  expect(deleted.status).toBe(204)

  const again = await register('ses_enddelete1', K)
  const newBridge = await connectBridge('ses_enddelete1', again.bridge_token)
  newBridge.emit(statusEvent('ses_enddelete1', 'second-share'))
  await settle(200)
  expect(stream.text).not.toContain('second-share')
  expect(stream.ended).toBe(true)
})

test('a share the reaper removes ends its viewer streams too', async () => {
  const { stream } = await liveShare('ses_endreap1')
  // Nothing has touched the share since the event above, so an idle limit of
  // zero reaps it, as the sweep would a day later.
  await settle(20)
  expect(store.reapOrphans(0)).toEqual(['ses_endreap1'])
  bridge.disconnect('ses_endreap1')

  const again = await register('ses_endreap1')
  const newBridge = await connectBridge('ses_endreap1', again.bridge_token)
  newBridge.emit(statusEvent('ses_endreap1', 'second-share'))
  await settle(200)
  expect(stream.text).not.toContain('second-share')
  expect(stream.ended).toBe(true)
})

test('a registration-end listener that throws neither fails the delete nor the sweep', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const seen: string[] = []
  const s = new Store()
  s.onRegistrationEnd(() => {
    throw new Error('boom')
  })
  s.onRegistrationEnd((id) => seen.push(id))
  s.createSession('ses_endthrow1', '/w', 't', OWNER_IP)
  s.createSession('ses_endthrow2', '/w', 't', OWNER_IP)
  expect(s.deleteSession('ses_endthrow1')).toBe(true)
  expect(s.reapOrphans(-1)).toEqual(['ses_endthrow2'])
  expect(seen).toEqual(['ses_endthrow1', 'ses_endthrow2'])
  expect(warn).toHaveBeenCalledTimes(2)
})

/**
 * Ending a share must free the stream slots of its viewers, even of one that
 * stopped reading.
 *
 * Slots are counted per session id and given back when a stream's connection
 * closes. The end of a registration only ended the streams: end() queues the
 * final chunk BEHIND the backlog, so for a peer that reads nothing it never
 * completes, 'close' never comes, and the heartbeat that could have noticed
 * was stopped with the stream. A revoked viewer holding the session's 64
 * streams with a small backlog (under the stuck-viewer cap) therefore kept all
 * of them after a stop and a new share of the same conversation: the next
 * viewer, with the new code, got 429 on /event and no live updates for as long
 * as those TCP connections lived (up to a day behind nginx), and their
 * backlogs stayed in memory just as long.
 */
test("a revoked viewer that stopped reading does not keep the session's stream slots from the next share", async () => {
  const id = 'ses_endslots1'
  const K = randomBytes(32).toString('base64url')
  const first = await register(id, K)
  const oldBridge = await connectBridge(id, first.bridge_token)
  const mallory = store.activate(first.access_code, id).viewer_token

  // The relay-side response of every /event stream, to see its backlog.
  const held: http.ServerResponse[] = []
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url === '/event') held.push(res)
  })
  const port = (server.address() as AddressInfo).port
  const raw: net.Socket[] = []
  try {
    // Every slot the session has, on sockets that never read.
    for (let i = 0; i < 64; i++) {
      const socket = net.connect(port, '127.0.0.1')
      raw.push(socket)
      await new Promise((resolve) => socket.once('connect', resolve))
      socket.write(`GET /event HTTP/1.1\r\nHost: x\r\nx-viewer-token: ${mallory}\r\n\r\n`)
      socket.pause()
    }
    expect(await eventually(() => held.length === 64 && held.every((res) => res.headersSent))).toBe(true)

    // A busy share: output until each stream has bytes the kernel did not take
    // (so its final chunk cannot go out), far below the stuck-viewer cap.
    const delta = JSON.stringify({ type: 'message.part.delta', properties: { sessionID: id, delta: 'x'.repeat(64 * 1024) } })
    for (let round = 0; round < 200 && !held.every((res) => res.writableLength > 0); round++) {
      oldBridge.emit(JSON.parse(delta))
      await settle(5)
    }
    expect(held.every((res) => !res.destroyed && res.writableLength > 0)).toBe(true)
    expect(Math.max(...held.map((res) => res.writableLength))).toBeLessThan(1024 * 1024)
    const revoked = held.slice()

    // The owner stops, shares the same conversation again, and a new viewer joins.
    const deleted = await fetch(`http://${base}/api/sessions/${id}`, {
      method: 'DELETE',
      headers: { 'x-bridge-token': first.bridge_token },
    })
    expect(deleted.status).toBe(204)
    const again = await register(id, K)
    const victor = store.activate(again.access_code, id).viewer_token

    // Its live stream opens (a 429 is retried, as the web UI's reader would).
    let status = 0
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const ac = new AbortController()
      streams.push(ac)
      const res = await fetch(`http://${base}/event`, { headers: { 'x-viewer-token': victor }, signal: ac.signal })
      status = res.status
      if (status !== 429) break
      await res.body?.cancel()
      await settle(100)
    }
    expect(status).toBe(200)
    // And the revoked viewer's backlogs were let go, not parked for its TCP lifetime.
    expect(await eventually(() => revoked.every((res) => res.destroyed || res.writableFinished))).toBe(true)
  } finally {
    for (const socket of raw) socket.destroy()
  }
}, 20_000)
