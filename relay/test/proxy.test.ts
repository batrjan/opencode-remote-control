import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { viewerTokenFrom } from './helpers/viewer-token'
import { startServer } from '../src/server'
import { filterProjects } from '../src/proxy/adapter'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * End-to-end proxy test: viewer HTTP → relay proxy adapter → WS → bridge
 * client → mock opencode, and back. The brief's sketch pointed the mock at
 * the hardcoded localhost:51863; like Task 2 we use an in-process mock on an
 * ephemeral port (51863 is the real, credentialed server on this machine).
 */

let relay: Server
let relayUrl: string
let opencode: Server
let bridge: RelayWSClient
let viewerToken: string
let sess2ViewerToken: string
let lastPromptBody: unknown
let lastPath: string

// The session API requires the shared relay key (read lazily from the env).
const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    lastPath = url.pathname
    if (req.method === 'GET' && url.pathname === '/session/ses_sess1/message') {
      return json(res, 200, [{ id: 'm1', limit: url.searchParams.get('limit') }])
    }
    if (req.method === 'GET' && url.pathname === '/session/ses_sess1/children') {
      return json(res, 200, [{ id: 'ses_child1', parentID: 'ses_sess1', title: 'subagent' }])
    }
    if (req.method === 'GET' && url.pathname === '/session/ses_child1/message') {
      return json(res, 200, [{ id: 'child-m1' }])
    }
    // Session-detail replies drive the ancestry walk (readableSessionId).
    // ses_grand1 descends from ses_sess1 via ses_child1; ses_stranger does not.
    if (req.method === 'GET' && url.pathname === '/session/ses_child1') {
      return json(res, 200, { id: 'ses_child1', parentID: 'ses_sess1', title: 'subagent' })
    }
    if (req.method === 'GET' && url.pathname === '/session/ses_grand1') {
      return json(res, 200, { id: 'ses_grand1', parentID: 'ses_child1', title: 'nested subagent' })
    }
    if (req.method === 'GET' && url.pathname === '/session/ses_grand1/message') {
      return json(res, 200, [{ id: 'grandchild-m1' }])
    }
    if (req.method === 'GET' && url.pathname === '/session/ses_stranger') {
      return json(res, 200, { id: 'ses_stranger', title: 'someone else' }) // no parentID
    }
    if (req.method === 'GET' && url.pathname === '/project') {
      // ?nomatch=1 simulates a session whose directory belongs to none of the
      // owner's registered projects (a scratch dir, a fresh checkout).
      if (url.searchParams.get('nomatch')) return json(res, 200, [{ id: 'p2', worktree: '/somewhere/else' }])
      return json(res, 200, [
        { id: 'p1', worktree: '/path' },
        { id: 'p2', worktree: '/somewhere/else' },
      ])
    }
    // opencode files a directory that belongs to no registered project under a
    // catch-all project whose worktree is that very directory.
    if (req.method === 'GET' && url.pathname === '/project/current') {
      return json(res, 200, { id: 'global', worktree: url.searchParams.get('directory'), vcs: 'git' })
    }
    // The review panel's diff: echo what the relay forwarded, so a test can
    // see which directory it ran in and that `workspace` never reached us.
    if (req.method === 'GET' && url.pathname === '/vcs/diff') {
      return json(res, 200, [
        {
          file: 'hello.txt',
          mode: url.searchParams.get('mode'),
          directory: url.searchParams.get('directory'),
          workspace: url.searchParams.get('workspace'),
        },
      ])
    }
    // Upstream's fork: a NEW root session (no parentID) holding a copy of the
    // transcript. Answered like opencode does, so a forwarded fork succeeds.
    if (req.method === 'POST' && /^\/session\/[^/]+\/fork$/.test(url.pathname)) {
      return json(res, 200, { id: 'ses_fork1', title: 'title (fork #1)', directory: '/path' })
    }
    if (req.method === 'GET' && url.pathname === '/session/ses_sess1/todo') {
      return json(res, 200, [{ id: 'todo1' }])
    }
    if (req.method === 'GET' && url.pathname === '/session/status') {
      return json(res, 200, { ses_sess1: 'idle-status', other: 'hidden' })
    }
    if (req.method === 'GET' && url.pathname === '/permission') {
      return json(res, 200, [
        { id: 'perm1', sessionID: 'ses_sess1', permission: 'bash' },
        { id: 'perm-other', sessionID: 'sess-other', permission: 'bash' },
      ])
    }
    if (req.method === 'POST' && /^\/session\/ses_sess1\/permissions\//.test(url.pathname)) {
      return json(res, 200, { ok: true, permissionID: url.pathname.split('/').pop() })
    }
    if (req.method === 'GET' && url.pathname === '/agent') return json(res, 200, [{ id: 'build' }])
    if (req.method === 'GET' && url.pathname === '/config') return json(res, 200, { model: 'test' })
    // A malicious or compromised bridge fully controls the upstream Content-Type
    // and body, so these stand in for a share trying to serve ACTIVE content on
    // the relay origin (script execution on-origin). The relay must never label
    // a proxied body text/html or image/svg+xml.
    if (req.method === 'GET' && url.pathname === '/lsp') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end('<script>alert(document.cookie)</script>')
    }
    if (req.method === 'GET' && url.pathname === '/formatter') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
      return res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    }
    if (req.method === 'POST' && url.pathname === '/session/ses_sess1/prompt_async') {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        lastPromptBody = JSON.parse(raw)
        json(res, 200, { ok: true })
      })
      return
    }
    json(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  const opencodePort = (opencode.address() as AddressInfo).port

  relay = await startServer(0)
  const relayPort = (relay.address() as AddressInfo).port
  relayUrl = `http://127.0.0.1:${relayPort}`

  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: 'ses_sess1', directory: '/path', title: 'title' })
  expect(created.status).toBe(201)
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id: 'ses_sess1' })
  expect(activated.status).toBe(200)
  viewerToken = viewerTokenFrom(activated)

  // ses_sess2 gets a viewer token but no bridge connection (for the 502 case).
  const created2 = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: 'ses_sess2', directory: '/path', title: 'title' })
  const activated2 = await request(relay).post('/api/activate').send({ code: created2.body.access_code, session_id: 'ses_sess2' })
  sess2ViewerToken = viewerTokenFrom(activated2)

  bridge = new RelayWSClient(
    relayUrl,
    new OpencodeClient(`http://127.0.0.1:${opencodePort}`, 'opencode', 'password'),
  )
  await bridge.connect('ses_sess1', created.body.bridge_token)
})

afterAll(async () => {
  bridge.close()
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

/**
 * Response hardening. The bridge (which the sharer controls) sets the upstream
 * Content-Type and body verbatim, so without an allow-list a share could serve
 * text/html or image/svg+xml on the relay origin (https://…) and run script
 * there against a viewer's session — persistence via a service worker,
 * IndexedDB, or a same-origin fetch carrying the viewer cookie. Anything
 * outside {application/json, text/plain, application/octet-stream} is relabelled
 * application/octet-stream, and every proxied response carries no-store plus a
 * lock-down CSP so even a mislabelled body cannot execute.
 */
test('a bridge text/html body is served as octet-stream, never text/html', async () => {
  const res = await request(relay).get('/lsp').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toMatch(/application\/octet-stream/)
  expect(res.headers['content-type']).not.toContain('text/html')
  expect(res.headers['cache-control']).toBe('private, no-store')
  expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
  // The body itself is untouched — only its label and the guard headers change.
  // supertest buffers an octet-stream body into res.body as a Buffer.
  const body = Buffer.isBuffer(res.body) ? res.body.toString() : res.text
  expect(body).toBe('<script>alert(document.cookie)</script>')
})

test('a bridge image/svg+xml body is served as octet-stream, never svg', async () => {
  const res = await request(relay).get('/formatter').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toMatch(/application\/octet-stream/)
  expect(res.headers['content-type']).not.toContain('svg')
  expect(res.headers['cache-control']).toBe('private, no-store')
  expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
})

test('a JSON proxied response stays JSON, with no-store and the lock-down CSP', async () => {
  const res = await request(relay).get('/config').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toMatch(/application\/json/)
  expect(res.body).toEqual({ model: 'test' })
  expect(res.headers['cache-control']).toBe('private, no-store')
  expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
})

test('a filtered proxied response also carries the guard headers', async () => {
  // /session/status is served by a dedicated handler (not the generic proxy
  // funnel), so it must set the same guard headers.
  const res = await request(relay).get('/session/status').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toMatch(/application\/json/)
  expect(res.headers['cache-control']).toBe('private, no-store')
  expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
})

test('proxy GET /session/:id/message', async () => {
  const res = await request(relay).get(`/session/ses_sess1/message`).set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'm1', limit: null }])
})

test('proxy forwards the limit query param', async () => {
  const res = await request(relay).get(`/session/ses_sess1/message?limit=5`).set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'm1', limit: '5' }])
})

test('proxy POST prompt_async forwards the JSON body', async () => {
  const res = await request(relay)
    .post('/session/ses_sess1/prompt_async')
    .set('x-viewer-token', viewerToken)
    .send({ parts: [{ type: 'text', text: 'hello' }] })
  expect(res.status).toBe(200)
  expect(lastPromptBody).toEqual({ parts: [{ type: 'text', text: 'hello' }] })
})

test('proxy allowlisted GET endpoints (todo, agent, config)', async () => {
  for (const [path, expected] of [
    ['/session/ses_sess1/todo', [{ id: 'todo1' }]],
    ['/agent', [{ id: 'build' }]],
    ['/config', { model: 'test' }],
  ] as const) {
    const res = await request(relay).get(path).set('x-viewer-token', viewerToken)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(expected)
  }
})

test('proxy GET /session/status is filtered to the viewer session only', async () => {
  const res = await request(relay).get('/session/status').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ses_sess1: 'idle-status' })
})

test('proxy rejects requests without a viewer token', async () => {
  const res = await request(relay).get('/session/ses_sess1/message')
  expect(res.status).toBe(401)
  expect(res.body.error).toBeTruthy()
})

test('proxy rejects an invalid viewer token', async () => {
  const res = await request(relay).get('/session/ses_sess1/message').set('x-viewer-token', 'wrong')
  expect(res.status).toBe(401)
  expect(res.body.error).toBeTruthy()
})

test('proxy refuses a session id that is not the viewer’s, instead of substituting it', async () => {
  // It used to answer such a request from the viewer's own session without a
  // word, which is how a tab left open on another share had its prompts and
  // shell commands carried out here (see cross-share-rebind.test.ts). "evil" is
  // not even a session id, so nothing is asked upstream at all.
  lastPath = ''
  const res = await request(relay).get(`/session/evil/message`).set('x-viewer-token', viewerToken)
  expect(res.status).toBe(401)
  expect(res.headers['x-oc-relay-auth']).toBe('viewer-invalid')
  expect(lastPath).toBe('')
})

test('proxy returns 502 when no bridge is connected for the session', async () => {
  const res = await request(relay).get(`/session/ses_sess2/message`).set('x-viewer-token', sess2ViewerToken)
  expect(res.status).toBe(502)
  expect(res.body.error).toBeTruthy()
})

test('bridge WS connection with a bad bridge token is rejected', async () => {
  const bad = new RelayWSClient(
    relayUrl,
    new OpencodeClient('http://127.0.0.1:1', 'opencode', 'password'),
  )
  await expect(bad.connect('ses_sess1', 'wrong-token')).rejects.toThrow()
})


/**
 * Permission replies from the viewer. The relay always appends its own
 * ?directory=… query to the forwarded path, so the bridge-side cross-session
 * guard must match on the pathname only — matching the raw path swallowed the
 * query into the captured permission id and rejected every reply with 403.
 */
test('viewer can answer a permission request of its own session', async () => {
  const res = await request(relay)
    .post('/session/ses_sess1/permissions/perm1')
    .set('x-viewer-token', viewerToken)
    .send({ response: 'once' })
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true, permissionID: 'perm1' })
})

test('viewer cannot answer a permission request raised by another session', async () => {
  const res = await request(relay)
    .post('/session/ses_sess1/permissions/perm-other')
    .set('x-viewer-token', viewerToken)
    .send({ response: 'once' })
  expect(res.status).toBe(403)
})

/**
 * Subagent sessions. Every :id is rewritten to the viewer's session, which is
 * what keeps a viewer inside its own share — but for the share's OWN children
 * that rewrite was silently wrong rather than safe: the UI lists them via
 * /session/:id/children and then rendered the PARENT's transcript under each
 * child's title. Children are readable as themselves; anything else still
 * collapses to the bound session.
 */
test('a child session of the share is read as itself, not as the parent', async () => {
  const res = await request(relay).get('/session/ses_child1/message').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'child-m1' }])
  expect(lastPath).toBe('/session/ses_child1/message')
})

test('a subagent that spawned after the first child read is still read as itself', async () => {
  // The ancestry walk asks upstream each time (no stale child-list cache), so
  // a child that did not exist at the first read still resolves correctly.
  const res = await request(relay).get('/session/ses_child1/message').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'child-m1' }])
})

test('a nested subagent (grandchild) is read as itself, not as the top parent', async () => {
  const res = await request(relay).get('/session/ses_grand1/message').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'grandchild-m1' }])
  expect(lastPath).toBe('/session/ses_grand1/message')
})

test('a session that is NOT a child is refused, not answered from the viewer session', async () => {
  lastPath = ''
  const res = await request(relay).get('/session/ses_stranger/message').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(401)
  expect(res.headers['x-oc-relay-auth']).toBe('viewer-invalid')
  // Only the ancestry probe that proved it foreign went upstream; the stranger's
  // transcript was never asked for, and neither was the viewer's own.
  expect(lastPath).toBe('/session/ses_stranger')
})

test('child reads do not widen the write surface', async () => {
  // POSTs are not child-readable: a prompt still lands on the bound session.
  const res = await request(relay)
    .post('/session/ses_child1/prompt_async')
    .set('x-viewer-token', viewerToken)
    .send({ parts: [] })
  expect(res.status).toBe(200)
  expect(lastPath).toBe('/session/ses_sess1/prompt_async')
})

/**
 * Upstream /project lists EVERY project the owner has open, so a viewer of one
 * shared session could read the filesystem paths of unrelated work.
 */
test('/project keeps only the project the shared session lives in', async () => {
  const res = await request(relay).get('/project').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'p1', worktree: '/path' }])
})

test('filterProjects keeps only the most specific containing project', () => {
  const raw = JSON.stringify([
    { id: 'exact', worktree: '/work/app' },
    { id: 'parent', worktree: '/work' },
    { id: 'root', worktree: '/' },
    { id: 'sibling', worktree: '/work/other' },
    { id: 'prefix-trap', worktree: '/work/ap' },
    { id: 'no-worktree' },
  ])
  // Only the closest ancestor of the directory survives — a '/' project must
  // NOT act as a catch-all, and '/work/ap' must not match '/work/app'.
  expect(JSON.parse(filterProjects(raw, '/work/app'))).toEqual([{ id: 'exact', worktree: '/work/app' }])
  // If nothing contains the directory, keep nothing.
  expect(JSON.parse(filterProjects(JSON.stringify([{ id: 'x', worktree: '/nope' }]), '/work'))).toEqual([])
  // Non-JSON and non-array bodies pass through untouched.
  expect(filterProjects('not json', '/work/app')).toBe('not json')
  expect(filterProjects('{"a":1}', '/work/app')).toBe('{"a":1}')
  expect(filterProjects(raw, '/work/app', 'text/plain')).toBe(raw)
})

/**
 * Cross-user isolation: viewer A holds ONLY ses_sess1's token. Naming ses_sess2
 * in a path is refused outright (it is not this viewer's session, and answering
 * it from ses_sess1 is what sent one tab's prompts into another share); naming
 * it in a query is rewritten back. One user can never read another user's
 * session, whatever id they supply.
 */
test('viewer A naming session ses_sess2 never reads ses_sess2 — and is told so', async () => {
  for (const attempt of [
    '/session/ses_sess2',
    '/session/ses_sess2/message',
    '/session/ses_sess2/children',
    '/session/ses_sess2%2F..%2Fses_sess1/message',
  ]) {
    lastPath = ''
    const res = await request(relay).get(attempt).set('x-viewer-token', viewerToken)
    expect(res.status).toBe(401)
    expect(res.headers['x-oc-relay-auth']).toBe('viewer-invalid')
    // The only upstream request a refusal may make is the ancestry probe that
    // proves the id foreign: a session detail, never ses_sess2's own data.
    expect(['', '/session/ses_sess2']).toContain(lastPath)
  }
  // A foreign id in the QUERY is still rewritten, not refused: the path names
  // the viewer's own session and that is what is served.
  for (const attempt of ['/session/ses_sess1/message?id=ses_sess2', '/session/ses_sess1/message?sessionID=ses_sess2']) {
    lastPath = ''
    const res = await request(relay).get(attempt).set('x-viewer-token', viewerToken)
    expect(res.status).toBe(200)
    expect(lastPath).toBe('/session/ses_sess1/message')
  }
})

test("viewer A's /session/ses_sess2/children is refused, never served ses_sess1's", async () => {
  lastPath = ''
  const res = await request(relay).get('/session/ses_sess2/children').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(401)
  expect(res.headers['x-oc-relay-auth']).toBe('viewer-invalid')
  expect(lastPath).not.toContain('/children')
})

test('a foreign session id is not accepted as a child of the viewer session', async () => {
  // ses_sess2 is not a child of ses_sess1, so the child-read path must refuse it.
  lastPath = ''
  const res = await request(relay).get('/session/ses_sess2/message').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(401)
  expect(res.headers['x-oc-relay-auth']).toBe('viewer-invalid')
  expect(lastPath).not.toContain('/message')
})

test('viewer A cannot activate against ses_sess2 without ses_sess2’s code', async () => {
  // A's own code is for ses_sess1; pairing it with ses_sess2 must be rejected, and
  // pairing a wrong code with ses_sess2 must be rejected the same way.
  const wrong = await request(relay).post('/api/activate').send({ code: 'ZZZZZZ', session_id: 'ses_sess2' })
  expect(wrong.status).toBe(400)
  expect(wrong.body).toEqual({ error: 'invalid code' })
})

/**
 * The ancestry walk cannot become a cross-user read: a foreign session whose
 * parent chain never reaches the viewer's bound session is refused, even on a
 * child-readable route — and the walk's own probe is the only thing of it that
 * goes upstream.
 */
test('a foreign session that is not a descendant is refused', async () => {
  lastPath = ''
  const res = await request(relay).get('/session/ses_stranger/message').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(401)
  expect(res.headers['x-oc-relay-auth']).toBe('viewer-invalid')
  expect(res.body).not.toEqual([{ id: 'm1', limit: null }]) // not the viewer's own transcript either
  expect(lastPath).not.toContain('/message')
})

test('POST to a subagent session is still pinned to the viewer session (writes never widen)', async () => {
  // child-read is GET-only; a prompt aimed at a child lands on the parent.
  lastPath = ''
  const res = await request(relay)
    .post('/session/ses_child1/prompt_async')
    .set('x-viewer-token', viewerToken)
    .send({ parts: [] })
  expect(res.status).toBe(200)
  expect(lastPath).toBe('/session/ses_sess1/prompt_async')
})

test('a malformed id on a child-readable route is refused instead of reaching upstream raw', async () => {
  for (const bad of ['not-a-session', 'ses_x%2f..%2fses_y', 'ses_x/../ses_y', '../secret']) {
    lastPath = ''
    const res = await request(relay).get(`/session/${bad}/message`).set('x-viewer-token', viewerToken)
    expect(res.status).toBeLessThan(500)
    // No transcript is served for it — not the raw input's, and not the bound
    // session's under its name. At most the ancestry probe for a well-formed id
    // (path normalisation can leave one) reaches upstream.
    expect(lastPath).not.toContain('/message')
  }
})

test('filterProjects keeps a project whose sandbox path contains the session directory', () => {
  const raw = JSON.stringify([
    { id: 'sandboxed', worktree: '/elsewhere', sandboxes: ['/sb/root', '/work'] },
    { id: 'unrelated', worktree: '/nope', sandboxes: ['/other'] },
  ])
  expect(JSON.parse(filterProjects(raw, '/work/app'))).toEqual([
    { id: 'sandboxed', worktree: '/elsewhere', sandboxes: ['/sb/root', '/work'] },
  ])
})

/**
 * The opencode web UI speaks two dialects against the same server: its
 * bootstrap fetches `/api/session?limit=…&order=desc` while the session view
 * uses `/session/…`. Upstream opencode answers both; the relay only mounted
 * the bare half, so a viewer joining a session whose project their browser had
 * not cached got 404 on `/api/session`, concluded there were no sessions, and
 * landed on an empty "create a session" screen instead of the share.
 */
test('the /api dialect reaches the same routes as the bare one', async () => {
  // Equivalence is the property under test: whatever the bare route answers,
  // its /api twin must answer identically (the fixture's exact body is beside
  // the point).
  const bareList = await request(relay).get('/session?limit=5000&order=desc').set('x-viewer-token', viewerToken)
  const apiList = await request(relay).get('/api/session?limit=5000&order=desc').set('x-viewer-token', viewerToken)
  expect(apiList.status).toBe(bareList.status)
  expect(apiList.status).toBe(200)
  expect(apiList.body).toEqual(bareList.body)

  const bareMsg = await request(relay).get('/session/ses_sess1/message').set('x-viewer-token', viewerToken)
  lastPath = ''
  const apiMsg = await request(relay).get('/api/session/ses_sess1/message').set('x-viewer-token', viewerToken)
  expect(apiMsg.status).toBe(200)
  expect(apiMsg.body).toEqual(bareMsg.body)
  // The /api twin forwards the BARE upstream path — opencode's canonical one.
  expect(lastPath).toBe('/session/ses_sess1/message')
})

test('the /api dialect enforces the same isolation as the bare one', async () => {
  // No token at all.
  expect((await request(relay).get('/api/session')).status).toBe(401)
  expect((await request(relay).get('/api/session/ses_sess1/message')).status).toBe(401)

  // A foreign session id is refused here too, never fetched raw and never
  // quietly answered from the caller's own session.
  lastPath = ''
  const foreign = await request(relay).get('/api/session/ses_sess2/message').set('x-viewer-token', viewerToken)
  expect(foreign.status).toBe(401)
  expect(foreign.headers['x-oc-relay-auth']).toBe('viewer-invalid')
  expect(lastPath).not.toContain('/message')

  // The other viewer's /api list matches their own bare list — not ses_sess1's.
  const otherBare = await request(relay).get('/session').set('x-viewer-token', sess2ViewerToken)
  const otherApi = await request(relay).get('/api/session').set('x-viewer-token', sess2ViewerToken)
  expect(otherApi.body).toEqual(otherBare.body)

  // Routes that are deliberately NOT proxied stay unreachable under /api —
  // and under their bare spelling. '/pty' is in this list because listing the
  // owner's terminals hands over their command, args, cwd and pid; see the
  // NOTE beside it in the adapter's allowlist.
  lastPath = ''
  for (const blocked of [
    '/api/experimental/worktree',
    '/api/auth',
    '/api/tui/control',
    '/pty',
    '/pty/shells',
    '/api/pty',
  ]) {
    expect((await request(relay).get(blocked).set('x-viewer-token', viewerToken)).status).toBe(404)
  }
  // None of them reached the bridge: they are not routes, not refusals.
  expect(lastPath).toBe('')
})

test('/api/project is filtered to the session project, like the bare route', async () => {
  const bare = await request(relay).get('/project').set('x-viewer-token', viewerToken)
  const api = await request(relay).get('/api/project').set('x-viewer-token', viewerToken)
  expect(api.status).toBe(bare.status)
  expect(api.body).toEqual(bare.body)
})

test('an already /api-prefixed allowlist entry is not double-prefixed', async () => {
  // '/api/agent' is in the allowlist as-is; '/api/api/agent' must not exist.
  expect((await request(relay).get('/api/api/agent').set('x-viewer-token', viewerToken)).status).toBe(404)
})

/**
 * A shared session does not always live inside one of the owner's registered
 * projects — a scratch dir or a fresh checkout files under opencode's
 * catch-all "global" project instead. The project filter then matched nothing
 * and returned [], which left the viewer authenticated but homeless: the UI
 * had no project to hang the session on, so it rendered "nothing here yet" at
 * the root instead of the share. Observed live: entering a valid code landed
 * on the empty project list.
 */
test('a session outside every registered project still gets its own project', async () => {
  const res = await request(relay).get('/project?nomatch=1').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  // Not empty — the UI needs exactly one project: the session's own, taken
  // from /project/current rather than the owner's unrelated list.
  expect(Array.isArray(res.body)).toBe(true)
  expect(res.body).toHaveLength(1)
  expect(res.body[0].worktree).toBe('/path')
  // And still none of the owner's unrelated projects.
  expect(JSON.stringify(res.body)).not.toContain('/somewhere/else')

  // The /api twin behaves identically.
  const api = await request(relay).get('/api/project?nomatch=1').set('x-viewer-token', viewerToken)
  expect(api.body).toEqual(res.body)
})

test('a session inside a registered project still gets that project, not the fallback', async () => {
  const res = await request(relay).get('/project').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'p1', worktree: '/path' }])
})

/**
 * The review panel ("Changes") loads its git and branch modes from
 * GET /vcs/diff, and git is the mode it opens in. Neither the relay nor the
 * bridge routed it, so the request met the catch-all 404; the UI swallows that
 * failure into an empty list and showed "No file changes yet" while the agent
 * was editing files in the shared repo. The diff is read in the session's
 * directory like every other proxied read, and nothing else under /vcs opens.
 */
test('the review panel reads the git diff of the shared directory', async () => {
  for (const [path, mode] of [
    ['/vcs/diff?mode=git&directory=%2Fetc&workspace=evil', 'git'],
    ['/vcs/diff?mode=branch&directory=%2Fetc&workspace=evil', 'branch'],
    ['/api/vcs/diff?mode=git', 'git'],
  ] as const) {
    lastPath = ''
    const res = await request(relay).get(path).set('x-viewer-token', viewerToken)
    expect(res.status).toBe(200)
    expect(lastPath).toBe('/vcs/diff')
    // The session's directory, never the one the caller named, and no workspace.
    expect(res.body).toEqual([{ file: 'hello.txt', mode, directory: '/path', workspace: null }])
  }

  expect((await request(relay).get('/vcs/diff?mode=git')).status).toBe(401)

  // Only the read: the raw patch download and the patch apply stay unrouted.
  for (const [method, path] of [
    ['post', '/vcs/diff?mode=git'],
    ['get', '/vcs/diff/raw?mode=git'],
    ['post', '/vcs/apply'],
  ] as const) {
    lastPath = ''
    const res = await request(relay)[method](path).set('x-viewer-token', viewerToken)
    expect(res.status).toBe(404)
    expect(lastPath).toBe('')
  }
})

/**
 * The UI's /fork command. opencode answers POST /session/:id/fork by creating
 * a NEW root session (no parentID) with a copy of the transcript, and the UI
 * then navigates to it. A viewer is bound to one session, and the fork is not
 * a descendant of it, so every read of the fork collapsed back to the bound
 * session: the page said "session not found" with no composer, and a reload
 * of its URL served "This session has ended" while the share was live. Each
 * attempt still left the owner another session holding a copy of the
 * conversation. The route is not proxied, so the UI shows "Request failed"
 * and the viewer stays on the share.
 */
test('a viewer cannot fork the shared session', async () => {
  for (const path of ['/session/ses_sess1/fork', '/api/session/ses_sess1/fork', '/session/ses_stranger/fork']) {
    lastPath = ''
    const res = await request(relay).post(path).set('x-viewer-token', viewerToken).send({ messageID: 'm1' })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })
    // Never forwarded: the owner's opencode was not asked to create a session.
    expect(lastPath).toBe('')
  }
})
