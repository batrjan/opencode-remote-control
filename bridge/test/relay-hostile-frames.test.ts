import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { opencodeAuthHeader } from '../src/config'
import { OpencodeClient } from '../src/opencode'
import { RelayWSClient } from '../src/relay'

/**
 * A frame from the relay that parses to something other than an object.
 *
 * The relay side of this pair crashed on exactly this frame (`JSON.parse`
 * returns null, the next line reads `.type` off it), which is what made a
 * four-byte frame able to end every share on the process. The bridge reads its
 * frames the same way, and the trust direction here is real: a bridge talks to
 * whatever relay URL the owner typed, and that relay is not trusted (it is why
 * the allowlist is re-derived on this side at all).
 *
 * It survives — the handler is awaited with a .catch — but a frame that is
 * simply not for us should cost a drop, not a logged bug, and the next frame on
 * that socket must still be served.
 */

const MAX_LOGGED = 'failed to handle a relay message'

let opencode: Server
let opencodeUrl: string

beforeEach(async () => {
  opencode = createServer((req, res) => {
    if (req.headers.authorization !== opencodeAuthHeader()) {
      res.writeHead(401).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify([{ id: 'msg_1' }]))
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`
})

afterEach(async () => {
  vi.restoreAllMocks()
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await sleep(20)
}

async function fakeRelay() {
  const wss = new WebSocketServer({ port: 0, path: '/bridge' })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const frames: Array<{ request_id?: string; status?: number }> = []
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'hello', features: [] }))
    socket.on('message', (raw, isBinary) => {
      if (isBinary) return
      try {
        frames.push(JSON.parse(String(raw)))
      } catch {
        /* not ours */
      }
    })
  })
  return {
    url: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    frames,
    send: (text: string) => {
      for (const socket of wss.clients) socket.send(text)
    },
    stop: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  }
}

test('a relay frame that is not an object is dropped, and the socket keeps working', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const relay = await fakeRelay()
  const bridge = new RelayWSClient(relay.url, new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''))
  try {
    await bridge.connect('ses_hostileFrames', 'token')
    await until(() => relay.frames.length > 0, 2000)
    for (const frame of ['null', '123', '"x"', 'true', '[]']) relay.send(frame)
    await sleep(50)
    // The frame after them is served as if they had never arrived.
    relay.send(JSON.stringify({ type: 'proxy', request_id: 'req_after', method: 'GET', path: '/session/ses_hostileFrames/message' }))
    await until(() => relay.frames.some((f) => f.request_id === 'req_after'), 10_000)
    expect(relay.frames.find((f) => f.request_id === 'req_after')?.status, 'the frame after the junk is answered').toBe(200)
    expect(
      warn.mock.calls.flat().filter((arg) => typeof arg === 'string' && arg.includes(MAX_LOGGED)),
      'a frame that is not ours is dropped, not reported as a bug in handling it',
    ).toEqual([])
  } finally {
    bridge.close()
    await relay.stop()
  }
})
