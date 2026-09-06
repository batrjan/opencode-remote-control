import { afterEach, beforeEach, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { startServer } from '../../relay/src/server'
import { backoffDelay } from '../src/config'
import { opencodeAuthHeader } from '../src/config'
import { OpencodeClient } from '../src/opencode'
import { RelayWSClient } from '../src/relay'

/**
 * Bridge-side keep-alive. A weak network usually does not close the socket —
 * it goes half-open, and without a heartbeat the share stays "connected"
 * while nothing reaches the viewer. The bridge must notice and re-dial.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
process.env.REMOTE_CONTROL_WS_PING_INTERVAL_MS = '60'
process.env.REMOTE_CONTROL_RECONNECT_BASE_MS = '30'
process.env.REMOTE_CONTROL_RECONNECT_MAX_MS = '120'
process.env.REMOTE_CONTROL_EVENT_RETRY_MS = '40'

let relay: Server
let relayUrl: string
let opencode: Server
let opencodeUrl: string
let eventSubscriptions = 0
let openEventStreams: import('node:http').ServerResponse[] = []

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeEach(async () => {
  eventSubscriptions = 0
  openEventStreams = []
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (req.headers.authorization !== opencodeAuthHeader()) return json(res, 401, { error: 'unauthorized' })
    if (url.pathname === '/global/health') return json(res, 200, { healthy: true })
    if (url.pathname === '/event') {
      eventSubscriptions += 1
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'hello', n: eventSubscriptions })}\n\n`)
      openEventStreams.push(res)
      return
    }
    json(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterEach(async () => {
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

async function register(session_id: string): Promise<string> {
  const res = await fetch(`${relayUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ session_id, directory: '/path', title: 'keepalive' }),
  })
  return ((await res.json()) as { bridge_token: string }).bridge_token
}

function client(): RelayWSClient {
  return new RelayWSClient(relayUrl, new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''))
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

test('backoffDelay grows, stays inside the ceiling and jitters', () => {
  expect(backoffDelay(1, 1000, 30_000)).toBeGreaterThanOrEqual(800)
  expect(backoffDelay(1, 1000, 30_000)).toBeLessThanOrEqual(1200)
  expect(backoffDelay(3, 1000, 30_000)).toBeGreaterThanOrEqual(3200) // 4s ±20%
  expect(backoffDelay(3, 1000, 30_000)).toBeLessThanOrEqual(4800)
  for (const attempt of [8, 20, 100]) {
    expect(backoffDelay(attempt, 1000, 30_000)).toBeLessThanOrEqual(30_000)
    expect(backoffDelay(attempt, 1000, 30_000)).toBeGreaterThan(0)
  }
  const samples = new Set(Array.from({ length: 20 }, () => backoffDelay(4, 1000, 30_000)))
  expect(samples.size).toBeGreaterThan(1)
})

test('a silent link is detected and re-dialled, then settles once answered', async () => {
  // The real failure mode: the socket stays OPEN but the far end is gone, so
  // nothing but an unanswered ping can reveal it. This stand-in relay refuses
  // to pong the first connection and answers every later one.
  const { WebSocketServer } = await import('ws')
  const wss = new WebSocketServer({ port: 0, path: '/bridge', autoPong: false })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const port = (wss.address() as AddressInfo).port
  const sockets: import('ws').WebSocket[] = []
  wss.on('connection', (socket) => {
    sockets.push(socket)
    const answer = sockets.length > 1
    socket.on('ping', () => {
      if (answer) socket.pong()
    })
  })

  const ws = new RelayWSClient(
    `http://127.0.0.1:${port}`,
    new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''),
  )
  let reconnects = 0
  ws.onReconnect = () => {
    reconnects += 1
  }
  try {
    await ws.connect('sess-halfopen', 'token')
    // First socket never pongs → terminated → re-dialled.
    expect(await waitFor(() => sockets.length >= 2)).toBe(true)
    expect(await waitFor(() => reconnects >= 1)).toBe(true)
    // The second socket answers, so it is kept instead of cycling forever.
    const settled = sockets.length
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(sockets.length).toBe(settled)
    expect(sockets[settled - 1]!.readyState).toBe(1)
  } finally {
    ws.close()
    wss.close()
  }
}, 15_000)

test('close() ends the share for good — no reconnect afterwards', async () => {
  const { WebSocketServer } = await import('ws')
  const wss = new WebSocketServer({ port: 0, path: '/bridge', autoPong: false })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const port = (wss.address() as AddressInfo).port
  let connections = 0
  wss.on('connection', () => {
    connections += 1
  })
  const ws = new RelayWSClient(
    `http://127.0.0.1:${port}`,
    new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''),
  )
  let reconnects = 0
  ws.onReconnect = () => {
    reconnects += 1
  }
  await ws.connect('sess-closed', 'token')
  ws.close()
  // Nothing answers the pings here either, but a closed client must not care.
  await new Promise((resolve) => setTimeout(resolve, 600))
  expect(reconnects).toBe(0)
  expect(connections).toBe(1)
  wss.close()
}, 15_000)

test('a relay that closes us on purpose is fatal, not retried', async () => {
  const token = await register('sess-fatal')
  const ws = client()
  let fatal: Error | undefined
  let reconnects = 0
  ws.onFatal = (err) => {
    fatal = err
  }
  ws.onReconnect = () => {
    reconnects += 1
  }
  await ws.connect('sess-fatal', token)
  // DELETE closes the bridge socket with 4001 (session closed).
  await fetch(`${relayUrl}/api/sessions/sess-fatal`, { method: 'DELETE', headers: { 'x-bridge-token': token } })
  expect(await waitFor(() => fatal !== undefined)).toBe(true)
  expect(fatal!.message).toMatch(/4001/)
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(reconnects).toBe(0)
  ws.close()
}, 15_000)

test('event forwarding re-subscribes when the opencode stream ends', async () => {
  const token = await register('sess-events')
  const ws = client()
  await ws.connect('sess-events', token)
  await ws.startEventForwarding()
  try {
    expect(await waitFor(() => eventSubscriptions === 1)).toBe(true)
    // opencode restarted / the stream died: end it from the server side.
    for (const res of openEventStreams) res.end()
    openEventStreams = []
    expect(await waitFor(() => eventSubscriptions >= 2)).toBe(true)
  } finally {
    ws.close()
  }
}, 15_000)

test('a stopped client does not resubscribe to events either', async () => {
  const token = await register('sess-events-stop')
  const ws = client()
  await ws.connect('sess-events-stop', token)
  await ws.startEventForwarding()
  expect(await waitFor(() => eventSubscriptions === 1)).toBe(true)
  ws.close()
  for (const res of openEventStreams) res.end()
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(eventSubscriptions).toBe(1)
}, 15_000)

/**
 * Production reality check: when the relay restarts it loses its in-memory
 * session store, so the bridge's re-dial is refused at the HTTP upgrade with
 * 401 — not with a close code. Retrying that forever keeps a dead share alive
 * in the process table; it has to end the share instead. A relay that is
 * merely DOWN must still be retried, since surviving that is the whole point.
 */
test('an upgrade rejected with 401 is fatal — the share ends instead of looping', async () => {
  const { WebSocketServer } = await import('ws')
  const wss = new WebSocketServer({ port: 0, path: '/bridge', verifyClient: (_info, done) => done(false) })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const port = (wss.address() as AddressInfo).port
  const ws = client()
  ;(ws as unknown as { relayUrl: string }).relayUrl = `http://127.0.0.1:${port}`
  let fatal: Error | undefined
  let reconnects = 0
  ws.onFatal = (err) => {
    fatal = err
  }
  ws.onReconnect = () => {
    reconnects += 1
  }
  await expect(ws.connect('sess-refused', 'stale-token')).rejects.toThrow()
  expect(await waitFor(() => fatal !== undefined)).toBe(true)
  expect(fatal!.message).toMatch(/401/)
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(reconnects).toBe(0)
  ws.close()
  wss.close()
}, 15_000)

test('a relay that is merely unreachable keeps being retried', async () => {
  // Nothing listens on this port: connect() fails, and the client must keep
  // trying rather than treating a transport error as a dead share.
  const { WebSocketServer } = await import('ws')
  const probe = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => probe.once('listening', resolve))
  const deadPort = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))

  const ws = client()
  ;(ws as unknown as { relayUrl: string }).relayUrl = `http://127.0.0.1:${deadPort}`
  let fatal: Error | undefined
  ws.onFatal = (err) => {
    fatal = err
  }
  await expect(ws.connect('sess-down', 'token')).rejects.toThrow()
  // A refused connection is not fatal — no onFatal, and a later listener on the
  // same port would be picked up by the backoff loop.
  expect(fatal).toBeUndefined()
  ws.close()
}, 15_000)
