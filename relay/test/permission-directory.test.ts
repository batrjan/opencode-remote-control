import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { startServer } from '../src/server'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * Permission prompts and session status of a share that lives outside the
 * opencode server's own directory.
 *
 * opencode keeps pending permission requests and session statuses in the
 * instance of a directory, and a request without ?directory=… reads the
 * SERVER's own instance. Measured on opencode 1.18.30: with the session's
 * directory, GET /permission listed the pending bash prompt and
 * GET /session/status said busy; without it they returned [] and {}. The relay
 * built both upstream paths without a query, and the bridge's ownership check
 * listed permissions without one too. So whenever the shared session lived
 * somewhere else (the desktop app hosting several projects, or a server
 * started from another folder) the guard looked in the wrong instance, found
 * no such request and refused every viewer answer with 403, the prompt vanished
 * from the viewer on reload, and a busy session looked idle. The session sat
 * blocked until the owner answered at their own keyboard.
 *
 * Real relay, real bridge client, mock opencode that holds permissions and
 * statuses only in the instance of the session's directory.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
process.env.ACTIVATE_FAIL_DELAY_MS = '0'

const SES = 'ses_permissionDir01'
const DIR = '/tmp/permission-proj'

const PERMISSIONS = [
  { id: 'per_mine', sessionID: SES, permission: 'bash', patterns: ['ls'] },
  { id: 'per_other', sessionID: 'ses_otherOwnerWork', permission: 'bash', patterns: ['rm'] },
]
const STATUSES = { [SES]: { type: 'busy' }, ses_otherOwnerWork: { type: 'busy' } }

let relay: Server
let opencode: Server
let bridge: RelayWSClient
let viewerCookie: string
/** Every request the mock opencode received: method, path + query, parsed body. */
const hits: Array<{ method: string; path: string; body?: unknown }> = []

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
      hits.push({ method: req.method ?? '', path: url.pathname + url.search, body: raw ? JSON.parse(raw) : undefined })
      // Any other directory (or none: the server's own) is an instance with
      // nothing pending and nothing running.
      const inSessionInstance = url.searchParams.get('directory') === DIR
      if (req.method === 'GET' && url.pathname === '/permission') {
        return json(res, 200, inSessionInstance ? PERMISSIONS : [])
      }
      if (req.method === 'GET' && url.pathname === '/session/status') {
        return json(res, 200, inSessionInstance ? STATUSES : {})
      }
      if (req.method === 'POST' && /^\/session\/[^/]+\/permissions\/[^/]+$/.test(url.pathname)) {
        return json(res, 200, true)
      }
      json(res, 404, { error: 'mock: no route' })
    })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  const opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`

  relay = await startServer(0)
  const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`

  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: SES, directory: DIR, title: 'permissions' })
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

beforeEach(() => {
  hits.length = 0
})

/** Directory each upstream request to `pathname` named (null: none). */
const directoriesOf = (method: string, pathname: string) =>
  hits
    .map((h) => ({ method: h.method, url: new URL(h.path, 'http://localhost') }))
    .filter((h) => h.method === method && h.url.pathname === pathname)
    .map((h) => h.url.searchParams.get('directory'))

test("a viewer answers a permission request of the shared session's instance", async () => {
  const res = await request(relay)
    .post(`/session/${SES}/permissions/per_mine?directory=%2Fgarbage`)
    .set('Cookie', viewerCookie)
    .send({ response: 'once' })
  expect({ status: res.status, body: res.body }).toEqual({ status: 200, body: true })
  // Ownership was checked in the instance the answer is sent to.
  expect(directoriesOf('GET', '/permission')).toEqual([DIR])
  expect(directoriesOf('POST', `/session/${SES}/permissions/per_mine`)).toEqual([DIR])
})

test("another session's permission request in that instance is still refused", async () => {
  const res = await request(relay)
    .post(`/session/${SES}/permissions/per_other`)
    .set('Cookie', viewerCookie)
    .send({ response: 'once' })
  expect(res.status).toBe(403)
  expect(res.body).toEqual({ error: 'permission request not found for this session' })
  expect(hits.filter((h) => h.method === 'POST')).toEqual([])
})

test('the pending permission list is read from the shared session instance', async () => {
  const res = await request(relay).get('/permission?directory=%2Fgarbage').set('Cookie', viewerCookie)
  expect(res.status).toBe(200)
  expect(res.body.map((p: { id: string }) => p.id)).toEqual(['per_mine'])
  expect(directoriesOf('GET', '/permission')).toEqual([DIR])
})

test('session status is read from the shared session instance', async () => {
  const res = await request(relay).get('/session/status').set('Cookie', viewerCookie)
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ [SES]: { type: 'busy' } })
  expect(directoriesOf('GET', '/session/status')).toEqual([DIR])
})
