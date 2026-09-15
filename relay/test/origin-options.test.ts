import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { startServer } from '../src/server'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * CSRF hardening + OPTIONS disclosure on the proxy router.
 *
 * The viewer cookie is SameSite=Strict, but that was the ONLY CSRF defence: a
 * same-site page could still drive a simple cross-origin POST (abort/summarize/
 * unrevert) with the ambient cookie. So a state-changing proxy POST that
 * carries an Origin header must have it equal the relay's own origin, else 403
 * — while a request with NO Origin (a non-browser client, a same-origin GET)
 * still works. And an OPTIONS must no longer be auto-answered by express with
 * an `Allow:` header that hands an unauthenticated client the route table.
 *
 * Real relay + real bridge client + mock opencode.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
process.env.ACTIVATE_FAIL_DELAY_MS = '0'

const SES = 'ses_originOptions01'
const DIR = '/tmp/origin-options-proj'

let relay: Server
let opencode: Server
let bridge: RelayWSClient
let viewerCookie: string
let relayUrl: string

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      // The abort endpoint the proxy binds to the viewer's session.
      if (req.method === 'POST' && url.pathname === `/session/${SES}/abort`) return json(res, 200, { ok: true })
      json(res, 404, { error: 'mock: no route' })
    })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  const opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`

  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`

  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: SES, directory: DIR, title: 'origin-options' })
  expect(created.status).toBe(201)
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id: SES })
  expect(activated.status).toBe(200)
  const setCookie = activated.headers['set-cookie'] as unknown as string[]
  viewerCookie = setCookie.find((c) => c.startsWith('viewer_token='))!.split(';')[0]!

  bridge = new RelayWSClient(relayUrl, new OpencodeClient(opencodeUrl, 'opencode', 'password'))
  await bridge.connect(SES, created.body.bridge_token, DIR)
})

afterAll(async () => {
  bridge?.close()
  relay?.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode?.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

test('a state-changing POST from a foreign Origin is refused with 403', async () => {
  const res = await request(relay)
    .post(`/session/${SES}/abort`)
    .set('Cookie', viewerCookie)
    .set('Origin', 'https://evil.example')
    .send({})
  expect(res.status).toBe(403)
})

test('a state-changing POST carrying the relay origin is accepted', async () => {
  const res = await request(relay)
    .post(`/session/${SES}/abort`)
    .set('Cookie', viewerCookie)
    .set('Origin', relayUrl)
    .send({})
  expect(res.status).toBe(200)
})

test('a state-changing POST with no Origin (non-browser client) is accepted', async () => {
  const res = await request(relay).post(`/session/${SES}/abort`).set('Cookie', viewerCookie).send({})
  expect(res.status).toBe(200)
})

test('OPTIONS on a proxy route no longer lists Allow', async () => {
  // Authenticated or not, an OPTIONS must not enumerate the route table.
  const res = await request(relay).options('/config')
  expect(res.headers.allow).toBeUndefined()
  // Answered as an unknown method, like every other unrouted request.
  expect(res.status).toBe(404)

  const res2 = await request(relay).options(`/session/${SES}/abort`).set('Cookie', viewerCookie)
  expect(res2.headers.allow).toBeUndefined()
  expect(res2.status).toBe(404)
})
