import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { viewerTokenFrom } from './helpers/viewer-token'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'
import { bridgeMaxPayloadBytes, proxyMaxBufferedBytes, sseMaxBufferBytes, sseMaxExemptBytes, sseMaxParkedBytes } from '../src/config'

/**
 * The frame cap and the byte budgets around it were two independent numbers.
 * maxPayload on the bridge socket (bridgeMaxPayloadBytes, 16 MiB) bounds ONE
 * frame; the SSE fan-out's one-frame exemption (sseMaxExemptBytes) defaulted to
 * 32 MiB, i.e. it promised to carry an event twice as large as any frame the
 * socket accepts. It never could: ws answers an over-maxPayload frame with a
 * protocol error on the socket, the relay terminates it (see the 'error'
 * handler in ws/bridge.ts), and the owner's bridge loses its link mid-share —
 * so the headroom between the two numbers was not "a huge event handled
 * gently", it was "the share drops". The first test below pins that mechanism;
 * the rest pin the relationship, so the numbers cannot drift apart again:
 *
 *  - nothing may claim to discount more of a frame than a frame can be, so the
 *    exemption is derived from, and clamped to, maxPayload;
 *  - a cap that admits a whole body (the proxy path's aggregate ceiling, the
 *    gunzip output limit) must leave room for one maximal frame, or a body the
 *    socket accepted is refused by the relay's own budget instead.
 */

const MiB = 1024 * 1024
const CONFIG_SRC = fileURLToPath(new URL('../src/config.ts', import.meta.url))
const BRIDGE_SRC = fileURLToPath(new URL('../src/ws/bridge.ts', import.meta.url))

const ENV = [
  'RELAY_BRIDGE_MAX_PAYLOAD_BYTES',
  'RELAY_SSE_MAX_EXEMPT_BYTES',
  'RELAY_SSE_MAX_PARKED_BYTES',
  'RELAY_PROXY_MAX_BUFFERED_BYTES',
  'ACTIVATE_FAIL_DELAY_MS',
]
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key]
  process.env.ACTIVATE_FAIL_DELAY_MS = '0'
})

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await sleep(20)
}

test('an event frame over maxPayload kills the bridge socket, so no SSE budget above it can ever apply', async () => {
  // Why the two numbers may not disagree, proven end to end: the exemption is
  // asked to carry a 6 MiB event while the socket only accepts 4 MiB frames.
  // The bridge is gone before the fan-out sees anything.
  process.env.RELAY_BRIDGE_MAX_PAYLOAD_BYTES = String(4 * MiB)
  process.env.RELAY_SSE_MAX_EXEMPT_BYTES = String(32 * MiB)
  const store = new Store()
  const relay = http.createServer()
  // maxPayload is read when the bridge server is constructed, so the env above
  // must already be set — mirrors how the relay reads it once at startup.
  const bridge = new BridgeClient(relay, store)
  relay.on('request', createApp(store, bridge))
  relay.on('close', () => bridge.close())
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  const port = (relay.address() as AddressInfo).port
  const id = 'ses_frame_over_maxpayload'
  let ws: WebSocket | undefined
  let viewer: net.Socket | undefined
  try {
    const created = await request(relay).post('/api/sessions').send({ session_id: id, directory: '/work', title: 't' })
    expect(created.status).toBe(201)
    const { access_code, bridge_token } = created.body as { access_code: string; bridge_token: string }
    const act = await request(relay).post('/api/activate').send({ code: access_code, session_id: id })
    const viewerToken = viewerTokenFrom(act)

    ws = new WebSocket(`http://127.0.0.1:${port}/bridge?session_id=${id}`.replace(/^http/, 'ws'), {
      headers: { 'x-bridge-token': bridge_token },
    })
    const socket = ws
    let closeCode: number | undefined
    await new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    socket.on('close', (code) => {
      closeCode = code
    })

    // A viewer that reads everything: it is not the viewer that is slow here.
    viewer = net.connect(port, '127.0.0.1')
    const reader = viewer
    reader.on('error', () => {})
    await new Promise((resolve) => reader.once('connect', resolve))
    const chunks: Buffer[] = []
    reader.on('data', (chunk: Buffer) => chunks.push(chunk))
    reader.write(`GET /event HTTP/1.1\r\nHost: x\r\nx-viewer-token: ${viewerToken}\r\n\r\n`)
    await until(() => chunks.length > 0, 3000)

    // One event carrying a pasted image as a data URL — the frame the exemption
    // exists for, sized between maxPayload and the exemption.
    const url = 'data:image/png;base64,' + 'A'.repeat(6 * MiB)
    const event = JSON.stringify({
      type: 'message.part.updated',
      properties: { part: { id: 'prt_big', messageID: 'msg_big', sessionID: id, type: 'file', url } },
    })
    socket.send(JSON.stringify({ type: 'event', data: event }))

    // The share's bridge link is gone (ws refuses the frame, the relay
    // terminates the socket), and the event never reached the viewer.
    await until(() => closeCode !== undefined, 5000)
    expect(closeCode, 'the bridge socket is closed on an over-maxPayload frame').toBeDefined()
    expect(Buffer.concat(chunks).toString('latin1')).not.toContain('prt_big')
  } finally {
    ws?.terminate()
    viewer?.destroy()
    relay.closeAllConnections()
    await new Promise((resolve) => relay.close(resolve))
  }
}, 30_000)

test('the SSE one-frame exemption never exceeds one frame, by default or by env', () => {
  // Defaults: on HEAD the exemption was 32 MiB against a 16 MiB frame cap.
  for (const key of ENV) if (key !== 'ACTIVATE_FAIL_DELAY_MS') delete process.env[key]
  expect(sseMaxExemptBytes()).toBeLessThanOrEqual(bridgeMaxPayloadBytes())

  // An install that pastes larger media raises the frame cap; the exemption
  // follows it, so the knob keeps meaning what it says.
  process.env.RELAY_BRIDGE_MAX_PAYLOAD_BYTES = String(64 * MiB)
  expect(sseMaxExemptBytes()).toBe(64 * MiB)

  // An exemption asked to exceed the frame cap is clamped to it, whichever way
  // round the two are set.
  process.env.RELAY_SSE_MAX_EXEMPT_BYTES = String(256 * MiB)
  expect(sseMaxExemptBytes()).toBe(64 * MiB)
  process.env.RELAY_BRIDGE_MAX_PAYLOAD_BYTES = String(8 * MiB)
  expect(sseMaxExemptBytes()).toBe(8 * MiB)

  // A smaller exemption is still honoured: bounding it below one frame is the
  // stuck-viewer defence (see sse-exempt-stall.test.ts), not a mismatch.
  process.env.RELAY_SSE_MAX_EXEMPT_BYTES = String(1 * MiB)
  expect(sseMaxExemptBytes()).toBe(1 * MiB)
})

test('every budget that must hold a whole frame leaves room for one maximal frame', () => {
  for (const key of ENV) if (key !== 'ACTIVATE_FAIL_DELAY_MS') delete process.env[key]
  // Defaults have to be coherent on their own — nobody sets these in practice.
  expect(proxyMaxBufferedBytes()).toBeGreaterThanOrEqual(bridgeMaxPayloadBytes())
  // The fan-out budget bounds what streams hold OVER the stuck-viewer cap, so
  // one maximal frame fits when that much of it is over the cap.
  expect(sseMaxParkedBytes()).toBeGreaterThanOrEqual(bridgeMaxPayloadBytes() - sseMaxBufferBytes())

  // The proxy ceiling holds eight frames, not one: the adapter gives each share
  // an eighth of it and no less than a whole frame (proxySessionShareBytes), so
  // below eight that per-share slice IS the ceiling and one hostile share can
  // still spend every other share's room.
  expect(proxyMaxBufferedBytes()).toBeGreaterThanOrEqual(8 * bridgeMaxPayloadBytes())

  // And a frame cap raised past the aggregate ceiling does not turn every
  // proxied response into 503 `relay busy`: a body the socket accepted is
  // admissible at least on its own.
  process.env.RELAY_BRIDGE_MAX_PAYLOAD_BYTES = String(96 * MiB)
  expect(proxyMaxBufferedBytes()).toBeGreaterThanOrEqual(96 * MiB)
  // A ceiling that already leaves room for eight frames is left exactly as the
  // operator set it; a smaller one is raised to that floor, not honoured.
  process.env.RELAY_PROXY_MAX_BUFFERED_BYTES = String(1024 * MiB)
  expect(proxyMaxBufferedBytes()).toBe(1024 * MiB)
  process.env.RELAY_PROXY_MAX_BUFFERED_BYTES = String(256 * MiB)
  expect(proxyMaxBufferedBytes()).toBe(8 * 96 * MiB)
})

test('config and the gunzip ceiling name maxPayload as the ceiling they derive from', () => {
  // The relationship has to be readable where the numbers are, or the next
  // person adds a third independent byte limit. Cheap guards, not prose checks.
  const config = fs.readFileSync(CONFIG_SRC, 'utf8')
  const exempt = config.slice(config.indexOf('export function sseMaxExemptBytes'))
  expect(exempt.slice(0, exempt.indexOf('}'))).toContain('bridgeMaxPayloadBytes()')
  // A compressed body is never inflated past what an uncompressed frame could
  // carry — the same ceiling, on the one path that could bypass maxPayload.
  expect(fs.readFileSync(BRIDGE_SRC, 'utf8')).toContain('Math.min(compressed.length * GZIP_MAX_RATIO, bridgeMaxPayloadBytes())')
})
