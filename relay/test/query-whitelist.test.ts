import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { startServer } from '../src/server'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * The proxy must force the session's directory AND strip every client-supplied
 * spelling of a directory/location/workspace/scope param, so no variant
 * (directory[], DIRECTORY, location[worktree]) reaches opencode and re-targets
 * the request at another workspace. Benign params (limit/before/…) survive.
 *
 * Real relay + real bridge client + mock opencode that records the full query.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
process.env.ACTIVATE_FAIL_DELAY_MS = '0'

const SES = 'ses_queryWhitelist01'
const DIR = '/tmp/query-whitelist-proj'

let relay: Server
let opencode: Server
let bridge: RelayWSClient
let viewerCookie: string
/** Every request the mock opencode received. */
const hits: Array<{ method: string; path: string }> = []

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
      hits.push({ method: req.method ?? '', path: url.pathname + url.search })
      // /file needs a JSON array so the proxy send path is happy.
      if (req.method === 'GET' && url.pathname === '/file') return json(res, 200, [])
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
    .send({ session_id: SES, directory: DIR, title: 'query-whitelist' })
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

test('directory/location/workspace/scope variants are stripped; forced directory set; pagination kept', async () => {
  const res = await request(relay)
    .get(
      '/file?' +
        [
          'directory=%2Fgarbage',
          'directory[]=%2Fother',
          'DIRECTORY=%2FUPPER',
          'location[worktree]=%2Fworktree',
          'location[directory]=%2Fsneaky',
          'workspace=remote-ws',
          'scope=all',
          'limit=20',
          'before=msg_abc',
          'cursor=c1',
        ].join('&'),
    )
    .set('Cookie', viewerCookie)
  expect(res.status).toBe(200)

  const hit = hits.find((h) => h.method === 'GET' && h.path.startsWith('/file'))
  expect(hit).toBeDefined()
  const params = new URL(hit!.path, 'http://localhost').searchParams

  // The two forced directory params carry the session's directory only.
  expect(params.getAll('directory')).toEqual([DIR])
  expect(params.getAll('location[directory]')).toEqual([DIR])
  // Every other client-supplied directory/location/workspace/scope spelling is gone.
  expect(params.has('directory[]')).toBe(false)
  expect(params.has('DIRECTORY')).toBe(false)
  expect(params.has('location[worktree]')).toBe(false)
  expect(params.has('workspace')).toBe(false)
  expect(params.has('scope')).toBe(false)
  // Benign pagination params survive untouched.
  expect(params.get('limit')).toBe('20')
  expect(params.get('before')).toBe('msg_abc')
  expect(params.get('cursor')).toBe('c1')
})
