import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { OpencodeClient } from '../src/opencode'
import { RelayWSClient } from '../src/relay'

/**
 * What one relay may make this machine do at once.
 *
 * The bridge answers every `proxy` frame the moment it arrives, so the relay —
 * a host the bridge merely dials — decided how many requests ran against the
 * owner's opencode in parallel, how many sockets and how much memory that
 * cost, and how large a single frame the bridge would buffer whole. None of
 * that is the relay's to decide: a compromised one (or a wedged one repeating
 * a queue) could exhaust the owner's machine without ever leaving the
 * allowlist.
 */
const SES = 'ses_inflight01'
const CAP = 8

beforeEach(() => {
  process.env.REMOTE_CONTROL_MAX_INFLIGHT_PROXY = String(CAP)
  process.env.REMOTE_CONTROL_WS_PING_INTERVAL_MS = '10000'
})

afterEach(() => {
  delete process.env.REMOTE_CONTROL_MAX_INFLIGHT_PROXY
  delete process.env.REMOTE_CONTROL_RELAY_MAX_PAYLOAD_BYTES
})

test('only so many proxy requests reach opencode at once; the rest are refused, not queued', async () => {
  let open = 0
  let peak = 0
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const opencode = {
    request: async () => {
      open++
      peak = Math.max(peak, open)
      await held
      open--
      return { status: 200, contentType: 'application/json', body: '{}' }
    },
  }
  const client = new RelayWSClient('http://relay.invalid', opencode as unknown as OpencodeClient)
  const sent: Array<{ request_id: string; status: number }> = []
  ;(client as unknown as { ws: unknown }).ws = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) }
  ;(client as unknown as { boundSessionId: string }).boundSessionId = SES
  const deliver = (raw: unknown) => (client as unknown as { onMessage(r: unknown): Promise<void> }).onMessage(raw)

  const frames = 200
  const all = Array.from({ length: frames }, (_, i) =>
    deliver(JSON.stringify({ type: 'proxy', request_id: `r${i}`, method: 'GET', path: `/session/${SES}/message` })),
  )
  // Everything over the cap is answered while opencode still holds the first
  // requests: a refusal now beats a queue that grows for as long as the relay
  // keeps sending.
  const deadline = Date.now() + 2000
  while (sent.length < frames - CAP && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  expect(peak).toBeLessThanOrEqual(CAP)
  expect(sent.filter((m) => m.status === 503)).toHaveLength(frames - CAP)
  release()
  await Promise.all(all)
  expect(sent.filter((m) => m.status === 200)).toHaveLength(CAP)

  // The cap is a ceiling on what is in flight, not a budget that runs out: the
  // next request is served as soon as one finishes.
  await deliver(JSON.stringify({ type: 'proxy', request_id: 'after', method: 'GET', path: `/session/${SES}/message` }))
  expect(sent.find((m) => m.request_id === 'after')?.status).toBe(200)
})

test('a frame larger than the bridge accepts drops the link instead of being buffered', async () => {
  process.env.REMOTE_CONTROL_RELAY_MAX_PAYLOAD_BYTES = String(64 * 1024)
  const wss = new WebSocketServer({ port: 0, path: '/bridge' })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const closes: number[] = []
  wss.on('connection', (socket) => {
    socket.on('error', () => socket.terminate())
    socket.on('close', (code) => closes.push(code))
  })
  const url = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`
  const client = new RelayWSClient(url, {} as OpencodeClient)
  try {
    await client.connect(SES, 'token')
    for (const socket of wss.clients) {
      socket.send(JSON.stringify({ type: 'hello', features: [], filler: 'A'.repeat(256 * 1024) }))
    }
    const deadline = Date.now() + 3000
    while (closes.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    // 1009 is "message too big": ws refused the frame rather than allocating it.
    expect(closes).toContain(1009)
  } finally {
    client.close()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  }
}, 15_000)
