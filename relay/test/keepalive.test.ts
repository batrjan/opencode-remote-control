import { afterEach, beforeEach, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { WebSocket } from 'ws'
import { startServer } from '../src/server'

/**
 * Keep-alive on a flaky network. A dropped connection often does not close:
 * both ends keep a half-open socket that reports OPEN while nothing crosses
 * it. These tests pin the two relay-side defences — pinging bridge sockets
 * and terminating silent ones, and heartbeating the viewer's SSE stream.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
// Shrink the timers so the suite does not wait 25s per round.
process.env.RELAY_WS_PING_INTERVAL_MS = '60'
process.env.RELAY_WS_PONG_GRACE_ROUNDS = '1'
process.env.RELAY_SSE_HEARTBEAT_MS = '80'

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

async function createSession(session_id: string) {
  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id, directory: '/path', title: 'keepalive' })
  expect(created.status).toBe(201)
  const activated = await request(relay)
    .post('/api/activate')
    .send({ code: created.body.access_code, session_id })
  return { bridgeToken: created.body.bridge_token as string, viewerToken: activated.body.viewer_token as string }
}

function connectBridge(session_id: string, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`${relayUrl.replace(/^http/, 'ws')}/bridge?session_id=${session_id}`, {
    headers: { 'x-bridge-token': token },
  })
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

test('the relay pings connected bridges', async () => {
  const { bridgeToken } = await createSession('sess-ping')
  const ws = await connectBridge('sess-ping', bridgeToken)
  try {
    const pinged = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000)
      ws.once('ping', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    expect(pinged).toBe(true)
  } finally {
    ws.terminate()
  }
})

test('a bridge that stops answering pings is dropped, not left half-open', async () => {
  const { bridgeToken, viewerToken } = await createSession('sess-silent')
  const ws = await connectBridge('sess-silent', bridgeToken)
  // Simulate a half-open socket: the client is up but never answers a ping.
  // (`ws` auto-pongs, so silence has to be forced.)
  ws.pong = () => {}
  const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
  await closed

  // The session is still registered — only its bridge is gone — so viewer
  // requests fail fast instead of hanging until the proxy timeout.
  const res = await request(relay).get('/session/sess-silent/message').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(502)
}, 10_000)

test('a live bridge that answers pings is never dropped', async () => {
  const { bridgeToken } = await createSession('sess-alive')
  const ws = await connectBridge('sess-alive', bridgeToken)
  try {
    let closedEarly = false
    ws.once('close', () => {
      closedEarly = true
    })
    await new Promise((resolve) => setTimeout(resolve, 400)) // several ping rounds
    expect(closedEarly).toBe(false)
    expect(ws.readyState).toBe(WebSocket.OPEN)
  } finally {
    ws.terminate()
  }
}, 10_000)

test('the viewer SSE stream keeps heartbeating with no bridge traffic at all', async () => {
  const { viewerToken } = await createSession('sess-sse')
  const res = await fetch(`${relayUrl}/event`, { headers: { 'x-viewer-token': viewerToken } })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    received += decoder.decode(value, { stream: true })
    if (received.split('server.heartbeat').length > 2) break
  }
  await reader.cancel()
  const beats = received.split('\n\n').filter((f) => f.includes('server.heartbeat'))
  expect(beats.length).toBeGreaterThanOrEqual(2)
  for (const frame of beats) {
    expect(frame.startsWith('data: ')).toBe(true)
    expect(JSON.parse(frame.slice(6)).properties).toEqual({})
  }
}, 10_000)

test('heartbeats on /global/event use the wrapped envelope', async () => {
  const { viewerToken } = await createSession('sess-sse-global')
  const res = await fetch(`${relayUrl}/global/event`, { headers: { 'x-viewer-token': viewerToken } })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    received += decoder.decode(value, { stream: true })
    if (received.includes('server.heartbeat')) break
  }
  await reader.cancel()
  const frame = received.split('\n\n').find((f) => f.includes('server.heartbeat'))!
  const parsed = JSON.parse(frame.slice(6))
  expect(parsed.directory).toBe('/path')
  expect(parsed.payload.type).toBe('server.heartbeat')
}, 10_000)

test('an empty or garbage keep-alive env var falls back to the default, never 0', async () => {
  const { sseRetryMs, sseHeartbeatMs, wsPingIntervalMs, wsPongGraceRounds } = await import('../src/config')
  for (const [key, fn, def] of [
    ['RELAY_SSE_RETRY_MS', sseRetryMs, 3000],
    ['RELAY_SSE_HEARTBEAT_MS', sseHeartbeatMs, 15_000],
    ['RELAY_WS_PING_INTERVAL_MS', wsPingIntervalMs, 25_000],
    ['RELAY_WS_PONG_GRACE_ROUNDS', wsPongGraceRounds, 2],
  ] as const) {
    const saved = process.env[key]
    try {
      for (const bad of ['', '   ', 'nope', '0', '-5', 'NaN']) {
        process.env[key] = bad
        expect(fn()).toBe(def) // never 0 (a tight-loop retry) or negative
      }
      process.env[key] = '1234'
      expect(fn()).toBe(1234)
    } finally {
      if (saved === undefined) delete process.env[key]
      else process.env[key] = saved
    }
  }
})
