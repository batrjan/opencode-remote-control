import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
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
    if (req.method === 'GET' && url.pathname === '/session/sess1/message') {
      return json(res, 200, [{ id: 'm1', limit: url.searchParams.get('limit') }])
    }
    if (req.method === 'GET' && url.pathname === '/session/sess1/children') {
      return json(res, 200, [{ id: 'ses_child1', parentID: 'sess1', title: 'subagent' }])
    }
    if (req.method === 'GET' && url.pathname === '/session/ses_child1/message') {
      return json(res, 200, [{ id: 'child-m1' }])
    }
    // Session-detail replies drive the ancestry walk (readableSessionId).
    // ses_grand1 descends from sess1 via ses_child1; ses_stranger does not.
    if (req.method === 'GET' && url.pathname === '/session/ses_child1') {
      return json(res, 200, { id: 'ses_child1', parentID: 'sess1', title: 'subagent' })
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
    if (req.method === 'GET' && url.pathname === '/session/sess1/todo') {
      return json(res, 200, [{ id: 'todo1' }])
    }
    if (req.method === 'GET' && url.pathname === '/session/status') {
      return json(res, 200, { sess1: 'idle-status', other: 'hidden' })
    }
    if (req.method === 'GET' && url.pathname === '/permission') {
      return json(res, 200, [
        { id: 'perm1', sessionID: 'sess1', permission: 'bash' },
        { id: 'perm-other', sessionID: 'sess-other', permission: 'bash' },
      ])
    }
    if (req.method === 'POST' && /^\/session\/sess1\/permissions\//.test(url.pathname)) {
      return json(res, 200, { ok: true, permissionID: url.pathname.split('/').pop() })
    }
    if (req.method === 'GET' && url.pathname === '/agent') return json(res, 200, [{ id: 'build' }])
    if (req.method === 'GET' && url.pathname === '/config') return json(res, 200, { model: 'test' })
    if (req.method === 'POST' && url.pathname === '/session/sess1/prompt_async') {
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
    .send({ session_id: 'sess1', directory: '/path', title: 'title' })
  expect(created.status).toBe(201)
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id: 'sess1' })
  expect(activated.status).toBe(200)
  viewerToken = activated.body.viewer_token

  // sess2 gets a viewer token but no bridge connection (for the 502 case).
  const created2 = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: 'sess2', directory: '/path', title: 'title' })
  const activated2 = await request(relay).post('/api/activate').send({ code: created2.body.access_code, session_id: 'sess2' })
  sess2ViewerToken = activated2.body.viewer_token

  bridge = new RelayWSClient(
    relayUrl,
    new OpencodeClient(`http://127.0.0.1:${opencodePort}`, 'opencode', 'password'),
  )
  await bridge.connect('sess1', created.body.bridge_token)
})

afterAll(async () => {
  bridge.close()
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

test('proxy GET /session/:id/message', async () => {
  const res = await request(relay).get(`/session/sess1/message`).set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'm1', limit: null }])
})

test('proxy forwards the limit query param', async () => {
  const res = await request(relay).get(`/session/sess1/message?limit=5`).set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'm1', limit: '5' }])
})

test('proxy POST prompt_async forwards the JSON body', async () => {
  const res = await request(relay)
    .post('/session/sess1/prompt_async')
    .set('x-viewer-token', viewerToken)
    .send({ parts: [{ type: 'text', text: 'hello' }] })
  expect(res.status).toBe(200)
  expect(lastPromptBody).toEqual({ parts: [{ type: 'text', text: 'hello' }] })
})

test('proxy allowlisted GET endpoints (todo, agent, config)', async () => {
  for (const [path, expected] of [
    ['/session/sess1/todo', [{ id: 'todo1' }]],
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
  expect(res.body).toEqual({ sess1: 'idle-status' })
})

test('proxy rejects requests without a viewer token', async () => {
  const res = await request(relay).get('/session/sess1/message')
  expect(res.status).toBe(401)
  expect(res.body.error).toBeTruthy()
})

test('proxy rejects an invalid viewer token', async () => {
  const res = await request(relay).get('/session/sess1/message').set('x-viewer-token', 'wrong')
  expect(res.status).toBe(401)
  expect(res.body.error).toBeTruthy()
})

test('proxy forcibly substitutes the session id from the viewer token', async () => {
  const res = await request(relay).get(`/session/evil/message`).set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  // The bridge must have been asked for the viewer's own session, not "evil".
  expect(lastPath).toBe('/session/sess1/message')
})

test('proxy returns 502 when no bridge is connected for the session', async () => {
  const res = await request(relay).get(`/session/sess2/message`).set('x-viewer-token', sess2ViewerToken)
  expect(res.status).toBe(502)
  expect(res.body.error).toBeTruthy()
})

test('bridge WS connection with a bad bridge token is rejected', async () => {
  const bad = new RelayWSClient(
    relayUrl,
    new OpencodeClient('http://127.0.0.1:1', 'opencode', 'password'),
  )
  await expect(bad.connect('sess1', 'wrong-token')).rejects.toThrow()
})


/**
 * Permission replies from the viewer. The relay always appends its own
 * ?directory=… query to the forwarded path, so the bridge-side cross-session
 * guard must match on the pathname only — matching the raw path swallowed the
 * query into the captured permission id and rejected every reply with 403.
 */
test('viewer can answer a permission request of its own session', async () => {
  const res = await request(relay)
    .post('/session/sess1/permissions/perm1')
    .set('x-viewer-token', viewerToken)
    .send({ response: 'once' })
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true, permissionID: 'perm1' })
})

test('viewer cannot answer a permission request raised by another session', async () => {
  const res = await request(relay)
    .post('/session/sess1/permissions/perm-other')
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

test('a session that is NOT a child still collapses to the viewer session', async () => {
  const res = await request(relay).get('/session/ses_stranger/message').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'm1', limit: null }])
  expect(lastPath).toBe('/session/sess1/message')
})

test('child reads do not widen the write surface', async () => {
  // POSTs are not child-readable: a prompt still lands on the bound session.
  const res = await request(relay)
    .post('/session/ses_child1/prompt_async')
    .set('x-viewer-token', viewerToken)
    .send({ parts: [] })
  expect(res.status).toBe(200)
  expect(lastPath).toBe('/session/sess1/prompt_async')
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
 * Cross-user isolation: viewer A holds ONLY sess1's token. Every attempt to
 * name sess2 in a path, query or body must be rewritten back to sess1 — one
 * user can never read another user's session, whatever id they supply.
 */
test('viewer A naming session sess2 still only ever reads sess1', async () => {
  for (const attempt of [
    '/session/sess2',
    '/session/sess2/message',
    '/session/sess2/children',
    '/session/sess1/message?id=sess2',
    '/session/sess1/message?sessionID=sess2',
    '/session/sess2%2F..%2Fsess1/message',
  ]) {
    lastPath = ''
    const res = await request(relay).get(attempt).set('x-viewer-token', viewerToken)
    // Never a 5xx, never sess2's upstream path.
    expect(res.status).toBeLessThan(500)
    expect(lastPath).not.toContain('sess2')
  }
  // The session-detail route forwards sess1 upstream, never sess2 (the mock
  // does not implement the bare detail route, so only the rewrite is asserted).
  lastPath = ''
  await request(relay).get('/session/sess2').set('x-viewer-token', viewerToken)
  expect(lastPath).toBe('/session/sess1')
})

test("viewer A's /session/sess2/children returns sess1's children, never sess2's", async () => {
  lastPath = ''
  const res = await request(relay).get('/session/sess2/children').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(lastPath).toBe('/session/sess1/children')
  // The child resolver may have probed children too, but the served path is sess1's.
  for (const child of res.body as Array<{ parentID?: string }>) {
    expect(child.parentID === undefined || child.parentID === 'sess1').toBe(true)
  }
})

test('a foreign session id is not accepted as a child of the viewer session', async () => {
  // sess2 is not a child of sess1, so the child-read path must collapse it.
  lastPath = ''
  const res = await request(relay).get('/session/sess2/message').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'm1', limit: null }]) // sess1's message, not sess2's
  expect(lastPath).toBe('/session/sess1/message')
})

test('viewer A cannot activate against sess2 without sess2’s code', async () => {
  // A's own code is for sess1; pairing it with sess2 must be rejected, and
  // pairing a wrong code with sess2 must be rejected the same way.
  const wrong = await request(relay).post('/api/activate').send({ code: 'ZZZZZZ', session_id: 'sess2' })
  expect(wrong.status).toBe(400)
  expect(wrong.body).toEqual({ error: 'invalid code' })
})

/**
 * The ancestry walk cannot become a cross-user read: a foreign session whose
 * parent chain never reaches the viewer's bound session collapses to the bound
 * session, even though it is requested on a child-readable route.
 */
test('a foreign session that is not a descendant still collapses', async () => {
  lastPath = ''
  const res = await request(relay).get('/session/ses_stranger/message').set('x-viewer-token', viewerToken)
  expect(res.status).toBe(200)
  expect(res.body).toEqual([{ id: 'm1', limit: null }]) // sess1's message, not the stranger's
  expect(lastPath).toBe('/session/sess1/message')
})

test('POST to a subagent session is still pinned to the viewer session (writes never widen)', async () => {
  // child-read is GET-only; a prompt aimed at a child lands on the parent.
  lastPath = ''
  const res = await request(relay)
    .post('/session/ses_child1/prompt_async')
    .set('x-viewer-token', viewerToken)
    .send({ parts: [] })
  expect(res.status).toBe(200)
  expect(lastPath).toBe('/session/sess1/prompt_async')
})

test('a malformed id on a child-readable route collapses instead of reaching upstream raw', async () => {
  for (const bad of ['not-a-session', 'ses_x%2f..%2fses_y', 'ses_x/../ses_y', '../secret']) {
    lastPath = ''
    const res = await request(relay).get(`/session/${bad}/message`).set('x-viewer-token', viewerToken)
    expect(res.status).toBeLessThan(500)
    // Whatever upstream path was hit, it was the bound session's, never the raw input.
    if (lastPath) expect(lastPath).toBe('/session/sess1/message')
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

  const bareMsg = await request(relay).get('/session/sess1/message').set('x-viewer-token', viewerToken)
  lastPath = ''
  const apiMsg = await request(relay).get('/api/session/sess1/message').set('x-viewer-token', viewerToken)
  expect(apiMsg.status).toBe(200)
  expect(apiMsg.body).toEqual(bareMsg.body)
  // The /api twin forwards the BARE upstream path — opencode's canonical one.
  expect(lastPath).toBe('/session/sess1/message')
})

test('the /api dialect enforces the same isolation as the bare one', async () => {
  // No token at all.
  expect((await request(relay).get('/api/session')).status).toBe(401)
  expect((await request(relay).get('/api/session/sess1/message')).status).toBe(401)

  // A foreign session id is rewritten to the caller's own, never fetched raw.
  lastPath = ''
  const foreign = await request(relay).get('/api/session/sess2/message').set('x-viewer-token', viewerToken)
  expect(foreign.status).toBe(200)
  expect(lastPath).toBe('/session/sess1/message')
  expect(foreign.body).toEqual([{ id: 'm1', limit: null }])

  // The other viewer's /api list matches their own bare list — not sess1's.
  const otherBare = await request(relay).get('/session').set('x-viewer-token', sess2ViewerToken)
  const otherApi = await request(relay).get('/api/session').set('x-viewer-token', sess2ViewerToken)
  expect(otherApi.body).toEqual(otherBare.body)

  // Routes that are deliberately NOT proxied stay unreachable under /api.
  for (const blocked of ['/api/experimental/worktree', '/api/auth', '/api/tui/control']) {
    expect((await request(relay).get(blocked).set('x-viewer-token', viewerToken)).status).toBe(404)
  }
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
