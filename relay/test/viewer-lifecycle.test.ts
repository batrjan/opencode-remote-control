import { afterEach, expect, test, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { Store } from '../src/store'
import { config } from '../src/config'
import { skillRouter } from '../src/api/skill'
import { activateRouter } from '../src/api/activate'

/**
 * Viewer-token lifecycle.
 *
 * A viewer token used to be immortal: created_at was written and never read,
 * so a token kept access for the whole life of the share, the per-session
 * viewer map grew without bound, and every proxied request scanned EVERY
 * session x EVERY viewer to authenticate one cookie. These tests pin the
 * sliding idle window, the LRU cap, and the O(1) lookup index — plus the
 * small correctness bugs found alongside them (confusable code letters, a
 * timingSafeEqual that threw on an empty stored hash, a registration slot
 * burned by a request that created nothing).
 */
process.env.ACTIVATE_FAIL_DELAY_MS = '0'

afterEach(() => {
  vi.useRealTimers()
})

test('a viewer token idle past the TTL stops authenticating and is pruned', () => {
  vi.useFakeTimers()
  const store = new Store()
  const { access_code } = store.createSession('s_exp', '/work', 'title', '1.1.1.1')
  const { viewer_token } = store.activate(access_code, 's_exp')
  expect(store.verifyViewer('s_exp', viewer_token)).toBe(true)

  vi.setSystemTime(Date.now() + config.viewerIdleTtlMs + 1000)
  expect(store.verifyViewer('s_exp', viewer_token)).toBe(false)
  expect(store.getSessionByViewerToken(viewer_token)).toBeUndefined()
  // Rejected AND forgotten: the map must not keep growing with dead tokens.
  expect(store.getSession('s_exp')?.viewers.size).toBe(0)
})

test('a viewer token in active use survives far past the idle window (sliding refresh)', () => {
  vi.useFakeTimers()
  const store = new Store()
  const { access_code } = store.createSession('s_slide', '/work', 'title', '1.1.1.1')
  const { viewer_token } = store.activate(access_code, 's_slide')

  // Four hops of just under the TTL each: the window slides on every use, so
  // a viewer who keeps watching is never logged out mid-session.
  for (let i = 0; i < 4; i++) {
    vi.setSystemTime(Date.now() + config.viewerIdleTtlMs - 60_000)
    expect(store.verifyViewer('s_slide', viewer_token)).toBe(true)
  }
  // Only going quiet for a full window ends it.
  vi.setSystemTime(Date.now() + config.viewerIdleTtlMs + 1000)
  expect(store.verifyViewer('s_slide', viewer_token)).toBe(false)
})

test('a seat nobody is sitting in is reclaimed at the cap', () => {
  vi.useFakeTimers()
  const store = new Store()
  const { access_code } = store.createSession('s_cap', '/work', 'title', '1.1.1.1')
  const tokens: string[] = []
  for (let i = 0; i < config.maxViewersPerSession; i++) {
    tokens.push(store.activate(access_code, 's_cap').viewer_token)
  }
  expect(store.getSession('s_cap')?.viewers.size).toBe(config.maxViewersPerSession)

  // Everyone goes quiet long enough to count as gone...
  vi.setSystemTime(Date.now() + config.viewerActiveWindowMs + 1000)
  // ...except the oldest token, which is used and therefore present again.
  expect(store.verifyViewer('s_cap', tokens[0]!)).toBe(true)
  const extra = store.activate(access_code, 's_cap').viewer_token

  expect(store.getSession('s_cap')?.viewers.size).toBe(config.maxViewersPerSession)
  // tokens[1] was the coldest idle seat, so it is the one that went.
  expect(store.verifyViewer('s_cap', tokens[1]!)).toBe(false)
  expect(store.getSessionByViewerToken(tokens[1]!)).toBeUndefined()
  // The refreshed oldest and the brand-new token both still work.
  expect(store.verifyViewer('s_cap', tokens[0]!)).toBe(true)
  expect(store.getSessionByViewerToken(extra)?.id).toBe('s_cap')
})

/**
 * The half that matters for abuse: at the cap, a viewer who is still PRESENT
 * is never displaced. Eviction used to take the least-recently-used token
 * whatever it was, so anyone holding the access code could mint tokens until
 * every existing viewer had been pushed out — no access they lacked, but a
 * silent eviction of everyone else.
 */
test('a full session refuses a new viewer instead of taking a present one\'s seat', () => {
  const store = new Store()
  const { access_code } = store.createSession('s_full', '/work', 'title', '1.1.1.1')
  const tokens: string[] = []
  for (let i = 0; i < config.maxViewersPerSession; i++) {
    tokens.push(store.activate(access_code, 's_full').viewer_token)
  }

  // Every seat was taken seconds ago, so every seat is occupied by somebody
  // present. The next join is refused — with its own error, because the code
  // was correct and the caller deserves to know that.
  expect(() => store.activate(access_code, 's_full')).toThrow('session full')

  // And nobody lost their seat to the attempt.
  expect(store.getSession('s_full')?.viewers.size).toBe(config.maxViewersPerSession)
  for (const t of tokens) expect(store.verifyViewer('s_full', t)).toBe(true)
})

test('the per-session mint budget bounds how fast tokens can be minted', () => {
  vi.useFakeTimers()
  const store = new Store()
  const { access_code } = store.createSession('s_mint', '/work', 'title', '1.1.1.1')
  // Age the existing viewers instead of moving the clock: seats must stay
  // reclaimable so the CAP is never what refuses, while the mint window —
  // which the clock would also reset — keeps running.
  const freeTheSeats = () => {
    const s = store.getSession('s_mint')!
    for (const v of s.viewers.values()) v.last_used = Date.now() - config.viewerActiveWindowMs - 1000
  }
  for (let i = 0; i < config.activationsPerSessionWindow; i++) {
    expect(store.activate(access_code, 's_mint').viewer_token).toBeTruthy()
    freeTheSeats()
  }
  // The budget is spent — with a seat free and a valid code in hand.
  expect(() => store.activate(access_code, 's_mint')).toThrow('rate limited')

  // It is a window, not a lifetime cap: it refills.
  vi.setSystemTime(Date.now() + config.activationSessionWindowMs + 1000)
  freeTheSeats()
  expect(store.activate(access_code, 's_mint').viewer_token).toBeTruthy()
})

test('re-sharing a session id does not inherit the old share mint budget', () => {
  const store = new Store()
  const first = store.createSession('s_reshare', '/work', 'title', '1.1.1.1')
  store.activate(first.access_code, 's_reshare')
  expect(store.deleteSession('s_reshare')).toBe(true)

  // opencode reuses the session id when the same session is shared again; the
  // new share must start with a clean counter and a clean viewer list.
  const second = store.createSession('s_reshare', '/work', 'title', '1.1.1.1')
  for (let i = 0; i < config.activationsPerSessionWindow; i++) {
    expect(store.activate(second.access_code, 's_reshare').viewer_token).toBeTruthy()
    // keep seats reclaimable
    const s = store.getSession('s_reshare')!
    for (const v of s.viewers.values()) v.last_used = Date.now() - config.viewerActiveWindowMs - 1000
  }
})

test('deleteSession leaves no lookup entry that can authenticate', () => {
  const store = new Store()
  const first = store.createSession('s_del', '/work', 'title', '1.1.1.1')
  const { viewer_token } = store.activate(first.access_code, 's_del')
  expect(store.getSessionByViewerToken(viewer_token)?.id).toBe('s_del')

  expect(store.deleteSession('s_del')).toBe(true)
  expect(store.getSessionByViewerToken(viewer_token)).toBeUndefined()

  // A new session reusing the id must not inherit the revoked viewer.
  const second = store.createSession('s_del', '/work', 'title', '1.1.1.1')
  expect(store.getSessionByViewerToken(viewer_token)).toBeUndefined()
  expect(store.verifyViewer('s_del', viewer_token)).toBe(false)
  const fresh = store.activate(second.access_code, 's_del')
  expect(store.getSessionByViewerToken(fresh.viewer_token)?.id).toBe('s_del')
})

test('reapOrphans revokes the reaped session viewer tokens too', () => {
  const store = new Store()
  const { access_code } = store.createSession('s_reap', '/work', 'title', '1.1.1.1')
  const { viewer_token } = store.activate(access_code, 's_reap')
  expect(store.getSessionByViewerToken(viewer_token)?.id).toBe('s_reap')

  expect(store.reapOrphans(-1)).toEqual(['s_reap'])
  expect(store.getSessionByViewerToken(viewer_token)).toBeUndefined()
  expect(store.verifyViewer('s_reap', viewer_token)).toBe(false)
})

test('a code typed with the letters O or I still activates (the alphabet has neither)', () => {
  const store = new Store()
  let typed: string | undefined
  let id = ''
  // The generator never emits O/I, so look for a code containing 0 or 1 and
  // type it the way someone reading it off a screen would.
  for (let i = 0; i < 100 && typed === undefined; i++) {
    id = `s_oi_${i}`
    const { access_code } = store.createSession(id, '/work', 'title', '1.1.1.1')
    if (/[01]/.test(access_code)) typed = access_code.replaceAll('0', 'O').replaceAll('1', 'I')
  }
  expect(typed).toBeDefined()
  expect(store.activate(typed!, id)).toEqual({
    session_id: id,
    viewer_token: expect.any(String),
  })
  // Folding happens after uppercasing, so the lowercase typo works as well.
  expect(store.activate(typed!.toLowerCase(), id, 'viewer-ip-2').session_id).toBe(id)
})

test('an empty stored bridge-token hash returns false instead of throwing', () => {
  const store = new Store()
  const { bridge_token } = store.createSession('s_empty', '/work', 'title', '1.1.1.1')
  const session = store.getSession('s_empty')!
  // What a truncated or hand-edited state file yields. timingSafeEqual throws
  // on a length mismatch, which turned a DELETE into a 500 (no catch-all).
  session.bridge_token_hash = ''
  expect(store.verifyBridgeToken('s_empty', bridge_token)).toBe(false)
  expect(store.verifyBridgeToken('s_empty', '')).toBe(false)
})

test('activate on a restored plaintext session (code hash stripped) fails cleanly', () => {
  const a = new Store()
  const created = a.createSession('s_pt', '/work', 'title', '1.1.1.1')
  const state = a.snapshot()
  // Exactly what a PLAINTEXT state file carries: no code hash, no code salt.
  delete state.sessions[0]!.code_hash
  delete state.sessions[0]!.code_salt

  const b = new Store()
  expect(b.restore(state)).toBe(1)
  expect(() => b.activate(created.access_code, 's_pt')).toThrow('invalid code')
})

test('last_used round-trips through snapshot/restore', () => {
  const a = new Store()
  const created = a.createSession('s_rt', '/work', 'title', '1.1.1.1')
  const { viewer_token } = a.activate(created.access_code, 's_rt')

  const state = a.snapshot()
  expect(typeof state.sessions[0]!.viewers[0]!.last_used).toBe('number')
  const fresh = new Store()
  expect(fresh.restore(state)).toBe(1)
  expect(fresh.verifyViewer('s_rt', viewer_token)).toBe(true)
  expect(fresh.getSessionByViewerToken(viewer_token)?.id).toBe('s_rt')

  // A viewer that had already gone idle before the restart must not come back
  // to life just because the snapshot still listed it.
  const stale = a.snapshot()
  stale.sessions[0]!.viewers[0]!.last_used = Date.now() - config.viewerIdleTtlMs - 1000
  const afterIdle = new Store()
  expect(afterIdle.restore(stale)).toBe(1)
  expect(afterIdle.verifyViewer('s_rt', viewer_token)).toBe(false)
  expect(afterIdle.getSession('s_rt')?.viewers.size).toBe(0)

  // And a file written before last_used existed falls back to created_at, so
  // the deploy that ships this change does not log every live viewer out.
  const legacy = a.snapshot()
  delete legacy.sessions[0]!.viewers[0]!.last_used
  const upgraded = new Store()
  expect(upgraded.restore(legacy)).toBe(1)
  expect(upgraded.verifyViewer('s_rt', viewer_token)).toBe(true)
})

test('a viewer restored from a pre-index state file still authenticates, and is re-indexed', () => {
  const a = new Store()
  const created = a.createSession('s_legacy', '/work', 'title', '1.1.1.1')
  const { viewer_token } = a.activate(created.access_code, 's_legacy')
  const state = a.snapshot()
  // An older relay persisted neither field; the index key cannot be derived
  // from a salted hash, so such a viewer is found by scan once, then indexed.
  delete state.sessions[0]!.viewers[0]!.last_used
  delete state.sessions[0]!.viewers[0]!.index

  const b = new Store()
  expect(b.restore(state)).toBe(1)
  expect(b.getSessionByViewerToken(viewer_token)?.id).toBe('s_legacy')
  expect(b.verifyViewer('s_legacy', viewer_token)).toBe(true)
  // An unknown token is still rejected (and now costs no scan at all).
  expect(b.getSessionByViewerToken('not-a-real-token')).toBeUndefined()
  expect(b.verifyViewer('s_legacy', 'not-a-real-token')).toBe(false)
})

test('a duplicate session_id registration (409) does not consume a registration slot', async () => {
  const store = new Store()
  const app = skillApp(store)
  const first = await post(app, 'd0')
  expect(first.status).toBe(201)

  // Eight duplicates: each creates nothing, so none may cost hourly quota.
  for (let i = 0; i < 8; i++) {
    expect((await post(app, 'd0')).status).toBe(409)
  }
  // Free the active-session slot so only the hourly cap is in play.
  const del = await request(app)
    .delete('/api/sessions/d0')
    .set('x-bridge-token', first.body.bridge_token as string)
  expect(del.status).toBe(204)

  // One slot used so far against a cap of 12, so five more must all succeed.
  // With the old accounting nine were burnt and this starts 429-ing.
  for (let i = 1; i <= 5; i++) {
    expect((await post(app, `d${i}`)).status).toBe(201)
  }
})

test('the per-IP active-session cap still applies', async () => {
  const store = new Store()
  const app = skillApp(store)
  for (let i = 0; i < config.maxActiveSessionsPerIp; i++) {
    expect((await post(app, `a${i}`)).status).toBe(201)
  }
  expect((await post(app, 'a_over')).status).toBe(429)
})

test('the viewer cookie carries an explicit lifetime and path', async () => {
  const store = new Store()
  const app = express()
  app.use(express.json())
  app.use('/api/activate', activateRouter(store))
  const { access_code } = store.createSession('s_cookie', '/work', 'title', '1.1.1.1')

  const res = await request(app)
    .post('/api/activate')
    .send({ code: access_code, session_id: 's_cookie' })
  expect(res.status).toBe(200)
  const setCookie = res.headers['set-cookie'] as unknown as string[]
  const cookie = setCookie.find((c) => c.startsWith('viewer_token='))!
  // Was a browser-session cookie: it died on browser restart while the token
  // stayed valid server-side, bouncing the viewer back to the join page.
  expect(cookie).toContain(`Max-Age=${Math.round(config.viewerIdleTtlMs / 1000)}`)
  expect(cookie).toContain('Path=/')
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('Secure')
  expect(cookie).toContain('SameSite=Strict')
})

function skillApp(store: Store) {
  const app = express()
  app.use(express.json())
  app.use('/api/sessions', skillRouter(store))
  return app
}

function post(app: express.Express, session_id: string) {
  return request(app).post('/api/sessions').send({ session_id, directory: '/work', title: 't' })
}
