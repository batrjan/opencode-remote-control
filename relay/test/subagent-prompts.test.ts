import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { viewerTokenFrom } from './helpers/viewer-token'
import { startServer } from '../src/server'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * Permission and question prompts raised by a SUBAGENT of the shared session.
 *
 * When the agent runs the task tool, opencode starts a child session (parentID =
 * the shared one) and every permission or question the subagent needs carries
 * the CHILD's session id. Measured on opencode 1.18.30: session.created for the
 * child, then permission.asked with sessionID = child, while the parent sat
 * busy waiting for it. The web UI shows such a prompt in the parent's dock by
 * walking the session tree, and answers it as POST
 * /session/<child>/permissions/<id> or POST /question/<id>/reply.
 *
 * The relay and the bridge scoped everything to the shared session id alone.
 * The event filter dropped the child's session.created and its permission.asked
 * and question.asked, GET /permission and GET /question left them out, GET
 * /session/<child> came back as the parent, and the bridge refused the answer
 * with 403 because the request did not belong to the bound session. The viewer
 * saw the parent spinning and could do nothing; the session stayed blocked until
 * the owner answered at their own keyboard.
 *
 * A subagent's prompts belong to the share: a descendant of the bound session
 * is in scope, proven by its parent chain (upstream, or the child's own
 * session.created on the share's event stream). Anything else stays out.
 *
 * Real relay, real bridge client, mock opencode shaped like the real one.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
process.env.ACTIVATE_FAIL_DELAY_MS = '0'

const DIR = '/work/subagent-proj'
const PARENT = 'ses_subParent01'
const CHILD = 'ses_subChild01'
const GRAND = 'ses_subGrand01'
const STRANGER = 'ses_subStranger01'
// Only ever announced on the event stream (upstream answers 404 for them), so
// the live test proves the relay learns a new subagent from its session.created.
const LIVE_CHILD = 'ses_subLiveChild01'
const LIVE_GRAND = 'ses_subLiveGrand01'
const LIVE_STRANGER_KID = 'ses_subStrangerKid01'

const info = (id: string, parentID?: string) => ({
  id,
  ...(parentID ? { parentID } : {}),
  directory: DIR,
  title: id,
  time: { created: 1, updated: 1 },
})
const SESSIONS = new Map([
  [PARENT, info(PARENT)],
  [CHILD, info(CHILD, PARENT)],
  [GRAND, info(GRAND, CHILD)],
  [STRANGER, info(STRANGER)],
])
const permission = (id: string, sessionID: string) => ({ id, sessionID, permission: 'bash', patterns: ['echo'], metadata: {}, always: [] })
const question = (id: string, sessionID: string) => ({ id, sessionID, questions: [{ question: 'Which DB?', header: 'DB', options: [] }] })

const PERMISSIONS = [
  permission('per_parent', PARENT),
  permission('per_child', CHILD),
  permission('per_grand', GRAND),
  permission('per_stranger', STRANGER),
]
const QUESTIONS = [question('que_child', CHILD), question('que_stranger', STRANGER)]

let relay: Server
let relayUrl: string
let opencode: Server
let bridge: RelayWSClient
let viewerToken: string
/** Writes that reached opencode: method + path + query. */
const writes: string[] = []
const eventClients = new Set<ServerResponse>()

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)
      eventClients.add(res)
      req.on('close', () => eventClients.delete(res))
      return
    }
    // Pending requests and statuses live in the instance of the directory the
    // request names.
    const inDir = url.searchParams.get('directory') === DIR
    if (req.method === 'POST') {
      writes.push(url.pathname + url.search)
      if (/^\/session\/[^/]+\/permissions\/[^/]+$/.test(url.pathname)) return json(res, 200, true)
      if (/^\/question\/[^/]+\/(reply|reject)$/.test(url.pathname)) return json(res, 200, true)
      return json(res, 404, { error: 'mock: no route' })
    }
    if (url.pathname === '/permission') return json(res, 200, inDir ? PERMISSIONS : [])
    if (url.pathname === '/question') return json(res, 200, inDir ? QUESTIONS : [])
    if (url.pathname === '/session/status') {
      return json(res, 200, inDir ? { [PARENT]: { type: 'busy' }, [CHILD]: { type: 'busy' }, [STRANGER]: { type: 'busy' } } : {})
    }
    const detail = /^\/session\/([^/]+)$/.exec(url.pathname)
    if (detail) {
      const found = SESSIONS.get(decodeURIComponent(detail[1]!))
      return found ? json(res, 200, found) : json(res, 404, { error: 'not found' })
    }
    json(res, 404, { error: 'mock: no route' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  const opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`

  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: PARENT, directory: DIR, title: 'shared' })
  expect(created.status).toBe(201)
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id: PARENT })
  expect(activated.status).toBe(200)
  viewerToken = viewerTokenFrom(activated)

  bridge = new RelayWSClient(relayUrl, new OpencodeClient(opencodeUrl, 'opencode', 'password'))
  await bridge.connect(PARENT, created.body.bridge_token, DIR)
  await bridge.startEventForwarding()
})

afterAll(async () => {
  bridge?.close()
  for (const client of eventClients) client.end()
  relay?.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode?.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

beforeEach(() => {
  writes.length = 0
})

const pathOf = (write: string) => new URL(write, 'http://localhost').pathname

test("the pending permission list keeps the share's subagents and drops other sessions", async () => {
  const res = await request(relay).get('/permission').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body.map((p: { id: string }) => p.id)).toEqual(['per_parent', 'per_child', 'per_grand'])
})

test('a viewer answers the permission prompt of a subagent, and of a nested one', async () => {
  const child = await request(relay)
    .post(`/session/${CHILD}/permissions/per_child`)
    .set('x-viewer-token', viewerToken)
    .send({ response: 'once' })
  expect(child.status).toBe(200)
  const grand = await request(relay)
    .post(`/api/session/${GRAND}/permissions/per_grand`)
    .set('x-viewer-token', viewerToken)
    .send({ response: 'once' })
  expect(grand.status).toBe(200)
  // Sent under the subagent's own id, in the session's directory.
  expect(writes.map(pathOf)).toEqual([`/session/${CHILD}/permissions/per_child`, `/session/${GRAND}/permissions/per_grand`])
  expect(new URL(writes[0]!, 'http://localhost').searchParams.get('directory')).toBe(DIR)
})

test("another session's permission stays refused, whichever session the path names", async () => {
  for (const sessionID of [CHILD, STRANGER, PARENT]) {
    const res = await request(relay)
      .post(`/session/${sessionID}/permissions/per_stranger`)
      .set('x-viewer-token', viewerToken)
      .send({ response: 'once' })
    expect(res.status).toBe(403)
  }
  expect(writes).toEqual([])
})

test("a subagent's question is listed, answered and dismissed; another session's is not", async () => {
  const list = await request(relay).get('/question').set('x-viewer-token', viewerToken)
  expect(list.status).toBe(200)
  expect(list.body.map((q: { id: string }) => q.id)).toEqual(['que_child'])

  const reply = await request(relay).post('/question/que_child/reply').set('x-viewer-token', viewerToken).send({ answers: [['pg']] })
  expect(reply.status).toBe(200)
  const reject = await request(relay).post('/question/que_child/reject').set('x-viewer-token', viewerToken).send({})
  expect(reject.status).toBe(200)
  const foreign = await request(relay).post('/question/que_stranger/reply').set('x-viewer-token', viewerToken).send({ answers: [['pg']] })
  expect(foreign.status).toBe(403)
  expect(writes.map(pathOf)).toEqual(['/question/que_child/reply', '/question/que_child/reject'])
})

test("a subagent's detail is its own, parent link included; a stranger still reads as the share", async () => {
  const child = await request(relay).get(`/session/${GRAND}`).set('x-viewer-token', viewerToken)
  expect(child.status).toBe(200)
  expect(child.body).toMatchObject({ id: GRAND, parentID: CHILD })

  const stranger = await request(relay).get(`/session/${STRANGER}`).set('x-viewer-token', viewerToken)
  expect(stranger.status).toBe(200)
  expect(stranger.body.id).toBe(PARENT)
  expect(stranger.body.parentID).toBeUndefined()
})

test('session status covers the share and its subagents only', async () => {
  const res = await request(relay).get('/session/status').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ [PARENT]: { type: 'busy' }, [CHILD]: { type: 'busy' } })
})

test("a new subagent's session, prompts and status reach the live stream; another session's do not", async () => {
  const ac = new AbortController()
  const res = await fetch(`${relayUrl}/global/event`, { headers: { 'x-viewer-token': viewerToken }, signal: ac.signal })
  expect(res.status).toBe(200)
  const received: Array<{ type: string; properties: Record<string, any> }> = []
  let sawEnd!: () => void
  const ended = new Promise<void>((resolve) => (sawEnd = resolve))
  const pump = (async () => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buf += decoder.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n')
          if (!data) continue
          const payload = JSON.parse(data).payload
          if (!payload || payload.type === 'server.heartbeat' || payload.type === 'server.connected') continue
          if (payload.type === 'session.idle') sawEnd()
          else received.push(payload)
        }
      }
    } catch {
      // aborted
    }
  })()
  await new Promise((resolve) => setTimeout(resolve, 200))

  const events = [
    { type: 'session.created', properties: { info: info(LIVE_CHILD, PARENT) } },
    { type: 'session.status', properties: { sessionID: LIVE_CHILD, status: { type: 'busy' } } },
    { type: 'permission.asked', properties: permission('per_live', LIVE_CHILD) },
    { type: 'session.created', properties: { info: info(LIVE_GRAND, LIVE_CHILD) } },
    { type: 'question.asked', properties: question('que_live', LIVE_GRAND) },
    // Another session of the owner, and a subagent of it.
    { type: 'session.created', properties: { info: info(LIVE_STRANGER_KID, STRANGER) } },
    { type: 'permission.asked', properties: permission('per_live_stranger', LIVE_STRANGER_KID) },
    { type: 'permission.asked', properties: permission('per_stranger', STRANGER) },
    { type: 'session.status', properties: { sessionID: STRANGER, status: { type: 'busy' } } },
    // An event that names a subagent AND another session is still dropped.
    { type: 'message.part.updated', properties: { part: { sessionID: LIVE_CHILD }, other: { sessionID: STRANGER } } },
    { type: 'permission.replied', properties: { sessionID: LIVE_CHILD, requestID: 'per_live', reply: 'once' } },
    { type: 'session.idle', properties: { sessionID: PARENT } },
  ]
  for (const ev of events) for (const client of eventClients) client.write(`data: ${JSON.stringify(ev)}\n\n`)
  await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 3000))])
  ac.abort()
  await pump

  expect(received.map((e) => [e.type, e.properties.info?.id ?? e.properties.id ?? e.properties.sessionID])).toEqual([
    ['session.created', LIVE_CHILD],
    ['session.status', LIVE_CHILD],
    ['permission.asked', 'per_live'],
    ['session.created', LIVE_GRAND],
    ['question.asked', 'que_live'],
    ['permission.replied', LIVE_CHILD],
  ])
})
