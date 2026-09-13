import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { startServer } from '../src/server'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * A viewer answering (or dismissing) a question the agent asked.
 *
 * The web UI talks the v1 dialect to the relay (its health probe says
 * healthy), and there the question dock's buttons call
 * POST /question/:requestID/reply and POST /question/:requestID/reject —
 * opencode's only question writes. Neither the relay nor the bridge allowlisted
 * them: both had been written for a "POST /question" that opencode does not
 * have. The relay answered its catch-all 404 (and a relay-only fix would have
 * met the bridge's 403), the UI showed "request failed", and with no
 * question.replied event the dock stayed up and the composer stayed blocked
 * until the owner answered at their own keyboard.
 *
 * Both routes carry only a request id, and opencode does not check which
 * session a request belongs to, so the bridge refuses ids that are not pending
 * questions of the shared session. The pending list is instance-wide in the
 * same way, and is filtered to the shared session like GET /permission.
 *
 * Real relay, real bridge client, mock opencode shaped like its question API.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
process.env.ACTIVATE_FAIL_DELAY_MS = '0'

const SES = 'ses_questionMine01'
const DIR = '/tmp/question-proj'

const QUESTIONS = [
  { id: 'que_mine', sessionID: SES, questions: [{ question: 'Proceed?', header: 'Go', options: [{ label: 'yes', description: '' }] }] },
  { id: 'que_other', sessionID: 'ses_otherOwnerWork', questions: [{ question: 'Private', header: 'x', options: [] }] },
]

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
      // Pending questions live in the instance of the directory the request
      // names; any other directory has none.
      if (req.method === 'GET' && url.pathname === '/question') {
        return json(res, 200, url.searchParams.get('directory') === DIR ? QUESTIONS : [])
      }
      if (req.method === 'POST' && /^\/question\/[^/]+\/(reply|reject)$/.test(url.pathname)) {
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
    .send({ session_id: SES, directory: DIR, title: 'questions' })
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

/** The question writes that reached opencode. */
const questionWrites = () => hits.filter((h) => h.method === 'POST' && h.path.startsWith('/question'))

test('a viewer answers a question of the shared session', async () => {
  const res = await request(relay)
    .post('/question/que_mine/reply')
    .set('Cookie', viewerCookie)
    .send({ answers: [['yes']] })
  expect(res.status).toBe(200)
  expect(res.body).toBe(true)
  const writes = questionWrites()
  expect(writes).toHaveLength(1)
  const sent = new URL(writes[0]!.path, 'http://localhost')
  expect(sent.pathname).toBe('/question/que_mine/reply')
  expect(sent.searchParams.get('directory')).toBe(DIR)
  expect(writes[0]!.body).toEqual({ answers: [['yes']] })
})

test('a viewer dismisses a question of the shared session', async () => {
  const res = await request(relay).post('/question/que_mine/reject').set('Cookie', viewerCookie).send({})
  expect(res.status).toBe(200)
  expect(questionWrites().map((h) => new URL(h.path, 'http://localhost').pathname)).toEqual(['/question/que_mine/reject'])
})

test('the /api dialect reaches the same opencode route', async () => {
  const res = await request(relay)
    .post('/api/question/que_mine/reply')
    .set('Cookie', viewerCookie)
    .send({ answers: [['yes']] })
  expect(res.status).toBe(200)
  expect(questionWrites().map((h) => new URL(h.path, 'http://localhost').pathname)).toEqual(['/question/que_mine/reply'])
})

test("another session's question can be neither answered nor dismissed", async () => {
  const reply = await request(relay)
    .post('/question/que_other/reply')
    .set('Cookie', viewerCookie)
    .send({ answers: [['yes']] })
  expect(reply.status).toBe(403)
  expect(reply.body).toEqual({ error: 'question request not found for this session' })
  const reject = await request(relay).post('/question/que_other/reject').set('Cookie', viewerCookie).send({})
  expect(reject.status).toBe(403)
  expect(questionWrites()).toEqual([])
})

test('a question id that is not pending anywhere is refused before opencode', async () => {
  const res = await request(relay)
    .post('/question/que_unknown/reply')
    .set('Cookie', viewerCookie)
    .send({ answers: [['yes']] })
  expect(res.status).toBe(403)
  expect(questionWrites()).toEqual([])
})

test('the pending question list shows only the shared session', async () => {
  const res = await request(relay).get('/question').set('Cookie', viewerCookie)
  expect(res.status).toBe(200)
  expect(res.body.map((q: { id: string }) => q.id)).toEqual(['que_mine'])
})

test('a viewer without a token is refused before anything is forwarded', async () => {
  const res = await request(relay).post('/question/que_mine/reply').send({ answers: [['yes']] })
  expect(res.status).toBe(401)
  expect(hits).toEqual([])
})

test('POST /question, which opencode does not have, is not routed', async () => {
  const res = await request(relay).post('/question').set('Cookie', viewerCookie).send({})
  expect(res.status).toBe(404)
  expect(hits).toEqual([])
})
