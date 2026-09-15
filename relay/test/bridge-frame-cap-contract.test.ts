import { afterEach, beforeEach, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import request from 'supertest'
import { viewerTokenFrom } from './helpers/viewer-token'
import { WebSocket } from 'ws'
import { startServer } from '../src/server'
import { GZIP_MAX_RATIO } from '../src/ws/bridge'
import { bridgeMaxPayloadBytes } from '../src/config'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * The largest frame a bridge may send is a PROTOCOL constant, not a relay-local
 * knob: bridges in the field were built against a 100 MiB ceiling and still
 * carry it (bridge/src/relay.ts GZIP_MAX_OUTPUT_BYTES, "mirrored from the
 * relay"). A relay that narrows it unilaterally cannot be rolled out, because
 * the owners' bridges cannot be rolled out with it — and the narrowing does not
 * fail one request, it costs the owner the link:
 *
 *  - a live event is always an uncompressed text frame (the bridge only gzips
 *    proxy responses), so an event past the cap is a ws protocol error, the
 *    relay terminates that socket and the share drops for every viewer at once;
 *  - a proxy response is inflated to at most the frame cap, so a body larger
 *    than it is 502 `proxy failed` however well it compressed — and the resync
 *    that follows a reconnect asks for the same transcript window again, so a
 *    single oversized message keeps failing for as long as it is in the window.
 *
 * These tests run on the DEFAULTS, because that is what ships.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY

const MiB = 1024 * 1024
const BRIDGE_SRC = fileURLToPath(new URL('../../bridge/src/relay.ts', import.meta.url))

let relay: Server
let relayUrl: string
let opencode: Server
let opencodeUrl: string
let transcript = ''

beforeEach(async () => {
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
  opencode = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(transcript)
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`
})

afterEach(async () => {
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await sleep(20)
}

async function share(session_id: string) {
  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id, directory: '/path', title: 'frames' })
  expect(created.status).toBe(201)
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id })
  expect(activated.status).toBe(200)
  return { bridgeToken: created.body.bridge_token as string, viewerToken: viewerTokenFrom(activated) }
}

/**
 * A transcript-shaped body of about `bytes`: prose that repeats, plus a random
 * tail per message so it compresses like a real one (a few-fold) rather than a
 * thousandfold. The point of the test is a body the bridge sends COMPRESSED.
 */
function makeTranscript(bytes: number): string {
  const parts: string[] = []
  let size = 0
  for (let i = 0; size < bytes; i++) {
    const text = `Step ${i}: lorem ipsum dolor sit amet, consectetur adipiscing elit. `.repeat(6) + Math.sin(i).toString(36) + Math.random().toString(36)
    const message = `{"info":{"id":"msg_${i}","role":"${i % 2 ? 'assistant' : 'user'}"},"parts":[{"id":"prt_${i}","type":"text","text":${JSON.stringify(text)}}]}`
    parts.push(message)
    size += message.length + 1
  }
  return `[${parts.join(',')}]`
}

test('a transcript larger than one frame, but well within it compressed, still reaches the viewer', async () => {
  // The everyday case, and the one a resync repeats: a long session (or one
  // file read) whose JSON is past the frame cap uncompressed and a fraction of
  // it on the wire. ee87864 served this in milliseconds.
  transcript = makeTranscript(20 * MiB)
  const compressed = gzipSync(Buffer.from(transcript, 'utf8')).length
  expect(transcript.length).toBeGreaterThan(16 * MiB)
  // Compresses well enough for the bridge to send it gzipped (below the ratio
  // the relay will inflate), and the frame that carries it is small.
  expect(transcript.length).toBeLessThan(compressed * GZIP_MAX_RATIO)
  expect(compressed).toBeLessThan(8 * MiB)

  const { bridgeToken, viewerToken } = await share('ses_big_transcript')
  const bridge = new RelayWSClient(relayUrl, new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''))
  try {
    await bridge.connect('ses_big_transcript', bridgeToken)
    const res = await request(relay).get('/session/ses_big_transcript/message').set('x-viewer-token', viewerToken)
    expect(res.status).toBe(200)
    expect(res.text.length).toBe(transcript.length)
  } finally {
    bridge.close()
  }
}, 60_000)

test('a live event carrying a pasted image does not cost the owner the bridge link', async () => {
  // message.part.updated with a data: URL — an uncompressed text frame, because
  // the bridge gzips proxy responses only. A ~13 MiB image is ~17 MiB base64.
  transcript = '[]'
  const { bridgeToken, viewerToken } = await share('ses_pasted_image')
  const port = (relay.address() as AddressInfo).port
  let ws: WebSocket | undefined
  let viewer: net.Socket | undefined
  try {
    ws = new WebSocket(`${relayUrl.replace(/^http/, 'ws')}/bridge?session_id=ses_pasted_image`, {
      headers: { 'x-bridge-token': bridgeToken },
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

    // A viewer that reads everything, so nothing here is about backpressure.
    viewer = net.connect(port, '127.0.0.1')
    const reader = viewer
    reader.on('error', () => {})
    await new Promise((resolve) => reader.once('connect', resolve))
    let seen = ''
    reader.on('data', (chunk: Buffer) => {
      seen += chunk.toString('latin1')
    })
    reader.write(`GET /event HTTP/1.1\r\nHost: x\r\nx-viewer-token: ${viewerToken}\r\n\r\n`)
    await until(() => seen.length > 0, 5000)

    const url = 'data:image/png;base64,' + 'A'.repeat(17 * MiB)
    const event = JSON.stringify({
      type: 'message.part.updated',
      properties: { part: { id: 'prt_pasted', messageID: 'msg_pasted', sessionID: 'ses_pasted_image', type: 'file', url } },
    })
    expect(event.length).toBeGreaterThan(16 * MiB)
    socket.send(JSON.stringify({ type: 'event', data: event }))

    await until(() => seen.includes('prt_pasted') || closeCode !== undefined, 20_000)
    expect(closeCode, 'the bridge socket stays open').toBeUndefined()
    expect(socket.readyState).toBe(WebSocket.OPEN)
    expect(seen).toContain('prt_pasted')
  } finally {
    ws?.terminate()
    viewer?.destroy()
  }
}, 60_000)

test('the relay frame cap is not narrower than the ceiling deployed bridges were built against', () => {
  // Both sides of the wire carry this number. Narrowing it on the relay alone
  // is the change a rolling deploy cannot survive: the bridges are on owners'
  // machines and are updated whenever they feel like it, if ever.
  const src = fs.readFileSync(BRIDGE_SRC, 'utf8')
  const declared = /GZIP_MAX_OUTPUT_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(src)
  expect(declared, 'bridge/src/relay.ts declares GZIP_MAX_OUTPUT_BYTES in MiB').not.toBeNull()
  expect(bridgeMaxPayloadBytes()).toBeGreaterThanOrEqual(Number(declared![1]) * MiB)
})
