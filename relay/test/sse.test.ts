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
 * re-emits as SSE to the viewer at /api/opencode/event.
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
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code })
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
  const res = await fetch(`${relayUrl}/api/opencode/event?session_id=sess1&token=${viewerToken}`)
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
  const res = await fetch(`${relayUrl}/api/opencode/event?session_id=sess1&token=wrong`)
  expect(res.status).toBe(401)
})
