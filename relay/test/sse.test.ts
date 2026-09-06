import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { startServer } from '../src/server'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * SSE fan-out test: mock opencode /event → bridge WS client forwards → relay
 * re-emits as SSE to the viewer at /event.
 */

let relay: Server
let relayUrl: string
let opencode: Server
let bridge: RelayWSClient
let viewerToken: string

// The session API requires the shared relay key (read lazily from the env).
const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      let n = 0
      const timer = setInterval(() => {
        res.write(`data: ${JSON.stringify({ type: 'heartbeat', n: n++ })}\n\n`)
      }, 50)
      req.on('close', () => clearInterval(timer))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  const opencodePort = (opencode.address() as AddressInfo).port

  relay = await startServer(0)
  const relayPort = (relay.address() as AddressInfo).port
  relayUrl = `http://127.0.0.1:${relayPort}`

  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: 'sess1', directory: '/path', title: 'title' })
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id: 'sess1' })
  viewerToken = activated.body.viewer_token

  bridge = new RelayWSClient(
    relayUrl,
    new OpencodeClient(`http://127.0.0.1:${opencodePort}`, 'opencode', 'password'),
  )
  await bridge.connect('sess1', created.body.bridge_token)
  await bridge.startEventForwarding()
})

afterAll(async () => {
  bridge.close()
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

test('viewer SSE stream receives opencode events pushed via the bridge', async () => {
  const res = await fetch(`${relayUrl}/event`, {
    headers: { 'x-viewer-token': viewerToken },
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const deadline = Date.now() + 4000
  while (!received.includes('"heartbeat"') && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    received += decoder.decode(value, { stream: true })
  }
  await reader.cancel()
  expect(received).toContain('"heartbeat"')
})

test('SSE endpoint rejects an invalid viewer token', async () => {
  const res = await fetch(`${relayUrl}/event`, {
    headers: { 'x-viewer-token': 'wrong' },
  })
  expect(res.status).toBe(401)
})

/**
 * Regression: the stream must open exactly like opencode's own /event — with
 * a `data:` frame and no SSE comment. The web UI's reader does not skip
 * comment lines; a leading `: connected` was parsed as an event and killed
 * the viewer's live stream immediately after connecting.
 */
test('the viewer stream sends no SSE comment line', async () => {
  const res = await fetch(`${relayUrl}/event`, { headers: { 'x-viewer-token': viewerToken } })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const deadline = Date.now() + 4000
  while (!received.includes('\n\n') && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    received += decoder.decode(value, { stream: true })
  }
  await reader.cancel()
  const frames = received.split('\n\n').filter((f) => f.trim().length > 0)
  expect(frames.length).toBeGreaterThan(0)
  for (const frame of frames) {
    const lines = frame.split('\n')
    for (const line of lines) {
      expect(line.startsWith(':')).toBe(false)
    }
    // Every frame carries data: a data-less frame is the shape that broke the
    // UI's reader, so `retry:` rides along with the handshake instead.
    expect(lines.some((l) => l.startsWith('data: '))).toBe(true)
  }
})

test('the handshake advertises a reconnect delay without a data-less frame', async () => {
  const res = await fetch(`${relayUrl}/event`, { headers: { 'x-viewer-token': viewerToken } })
  const reader = res.body!.getReader()
  const { value } = await reader.read()
  await reader.cancel()
  const first = new TextDecoder().decode(value).split('\n\n')[0]!
  const lines = first.split('\n')
  expect(lines[0]).toMatch(/^retry: \d+$/)
  expect(lines[1]).toMatch(/^data: /)
  expect(JSON.parse(lines[1]!.slice(6)).type).toBe('server.connected')
})

test('the stream opens with a server.connected frame, like opencode does', async () => {
  const res = await fetch(`${relayUrl}/event`, { headers: { 'x-viewer-token': viewerToken } })
  const reader = res.body!.getReader()
  const { value } = await reader.read()
  await reader.cancel()
  const first = new TextDecoder().decode(value).split('\n\n')[0]!
  const dataLine = first.split('\n').find((l) => l.startsWith('data: '))!
  const event = JSON.parse(dataLine.slice(6))
  expect(event.type).toBe('server.connected')
  expect(event.properties).toEqual({})
  expect(typeof event.id).toBe('string')
})

test('every forwarded frame is a parseable event object with properties', async () => {
  const res = await fetch(`${relayUrl}/event`, { headers: { 'x-viewer-token': viewerToken } })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const deadline = Date.now() + 4000
  while (received.split('\n\n').length < 3 && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    received += decoder.decode(value, { stream: true })
  }
  await reader.cancel()
  const payloads = received
    .split('\n\n')
    .filter((f) => f.trim().length > 0)
    .map((f) =>
      f
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n'),
    )
  expect(payloads.length).toBeGreaterThan(0)
  for (const payload of payloads) {
    expect(() => JSON.parse(payload)).not.toThrow()
    expect(typeof JSON.parse(payload)).toBe('object')
  }
})

/**
 * Envelope contract. opencode's `/event` emits the bare event while
 * `/global/event` wraps it as `{ directory, project, payload }`. The web UI
 * subscribes to the global stream and reads `e.payload.…`, so forwarding the
 * bare event there killed the viewer's live stream on the first event.
 */
async function firstFrames(path: string, count: number): Promise<unknown[]> {
  const res = await fetch(`${relayUrl}${path}`, { headers: { 'x-viewer-token': viewerToken } })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const deadline = Date.now() + 5000
  while (received.split('\n\n').filter((f) => f.trim()).length < count && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    received += decoder.decode(value, { stream: true })
  }
  await reader.cancel()
  return received
    .split('\n\n')
    .filter((f) => f.trim().length > 0)
    .slice(0, count)
    .map((f) =>
      JSON.parse(
        f
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n'),
      ),
    )
}

test('/event forwards the bare event envelope', async () => {
  const frames = (await firstFrames('/event', 2)) as Array<Record<string, unknown>>
  expect(frames[0]).toMatchObject({ type: 'server.connected' })
  const forwarded = frames[1] as { type?: string; payload?: unknown }
  expect(forwarded.payload).toBeUndefined()
  expect(forwarded.type).toBe('heartbeat')
})

test('/global/event wraps every frame in { directory, payload }', async () => {
  const frames = (await firstFrames('/global/event', 2)) as Array<Record<string, any>>
  // Handshake: payload only, no directory — exactly like opencode.
  expect(frames[0]!.payload).toMatchObject({ type: 'server.connected', properties: {} })
  expect(frames[0]!.directory).toBeUndefined()
  // Forwarded events carry the session's directory and the untouched payload.
  expect(frames[1]!.directory).toBe('/path')
  expect(frames[1]!.payload).toMatchObject({ type: 'heartbeat' })
})
