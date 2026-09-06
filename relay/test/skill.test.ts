import { expect, test } from 'vitest'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import request from 'supertest'

/**
 * Public session API: registration is open (rate-limited per IP) so the
 * skill works out of the box; DELETE requires the session's own bridge_token
 * so only the owner can kill a share.
 */
process.env.ACTIVATE_FAIL_DELAY_MS = '0'

test('POST /api/sessions is public (no key) and creates the session', async () => {
  const app = createApp(new Store())
  const res = await request(app)
    .post('/api/sessions')
    .send({ session_id: 'sess1', directory: '/path', title: 'title' })
  expect(res.status).toBe(201)
  expect(res.body.session_id).toBe('sess1')
  expect(res.body.access_code).toMatch(/^[A-Z0-9]{6}$/)
  expect(res.body.bridge_token).toBeTruthy()
})

test('POST /api/sessions with a duplicate session_id is 409 and keeps the original', async () => {
  const store = new Store()
  const app = createApp(store)
  const first = await request(app)
    .post('/api/sessions')
    .send({ session_id: 'sess1', directory: '/path', title: 'title' })
  expect(first.status).toBe(201)
  const res = await request(app)
    .post('/api/sessions')
    .send({ session_id: 'sess1', directory: '/other', title: 'takeover' })
  expect(res.status).toBe(409)
  expect(res.body.error).toBeTruthy()
  // The original session (and its code) must be untouched.
  expect(store.getSession('sess1')?.directory).toBe('/path')
})

test('POST /api/sessions rate-limits registrations per IP', async () => {
  const app = createApp(new Store())
  // The per-IP hourly cap is 12; the 13th must be rejected.
  let last = 0
  for (let i = 0; i < 13; i++) {
    const res = await request(app)
      .post('/api/sessions')
      .send({ session_id: `sess_rl_${i}`, directory: '/path', title: 't' })
    last = res.status
    if (last === 429) break
  }
  expect(last).toBe(429)
})

test('DELETE /api/sessions/:id without a bridge token is 404 (owner-only delete)', async () => {
  const store = new Store()
  store.createSession('sess1', '/path', 'title', 'test-ip')
  const app = createApp(store)
  const res = await request(app).delete('/api/sessions/sess1')
  expect(res.status).toBe(404)
  expect(store.getSession('sess1')).toBeTruthy()
})

test('DELETE /api/sessions/:id with a wrong bridge token is 404 (no oracle)', async () => {
  const store = new Store()
  store.createSession('sess1', '/path', 'title', 'test-ip')
  const app = createApp(store)
  const res = await request(app).delete('/api/sessions/sess1').set('x-bridge-token', 'wrong-token')
  expect(res.status).toBe(404)
  expect(store.getSession('sess1')).toBeTruthy()
})

test('DELETE /api/sessions/:id with the session bridge token removes it (204) and revokes the code', async () => {
  const store = new Store()
  const { access_code, bridge_token } = store.createSession('sess1', '/path', 'title', 'test-ip')
  const app = createApp(store)
  const res = await request(app).delete('/api/sessions/sess1').set('x-bridge-token', bridge_token)
  expect(res.status).toBe(204)
  expect(store.getSession('sess1')).toBeUndefined()
  // The access code is revoked with the session.
  const activated = await request(app).post('/api/activate').send({ code: access_code, session_id: 'sess1' })
  expect(activated.status).toBe(400)
})

test('DELETE /api/sessions/:id on an unknown session is 404 even with a token', async () => {
  const app = createApp(new Store())
  const res = await request(app).delete('/api/sessions/nope').set('x-bridge-token', 'whatever')
  expect(res.status).toBe(404)
})

test('GET /api/sessions/:id is public presence only — no directory, title or secrets', async () => {
  const store = new Store()
  store.createSession('sess1', '/private/host/path', 'a private title', 'test-ip')
  const app = createApp(store)
  const res = await request(app).get('/api/sessions/sess1')
  expect(res.status).toBe(200)
  expect(res.body.session_id).toBe('sess1')
  expect(res.body.status).toBe('active')
  expect(res.body.viewer_count).toBe(0)
  // A session id is not a secret (it is in the share URL), so directory and
  // title — a host path and a private label — must NOT be public.
  expect(res.body.directory).toBeUndefined()
  expect(res.body.title).toBeUndefined()
  // And no credential material, ever.
  expect(res.body.access_code).toBeUndefined()
  expect(res.body.bridge_token).toBeUndefined()
  expect(res.body.code_hash).toBeUndefined()
  expect(res.body.bridge_token_hash).toBeUndefined()
  const missing = await request(app).get('/api/sessions/nope')
  expect(missing.status).toBe(404)
})

test('GET /api/sessions/:id returns directory and title ONLY to the owning bridge token', async () => {
  const store = new Store()
  const { bridge_token } = store.createSession('sess1', '/private/host/path', 'a private title', 'test-ip')
  const app = createApp(store)

  const owner = await request(app).get('/api/sessions/sess1').set('x-bridge-token', bridge_token)
  expect(owner.status).toBe(200)
  expect(owner.body.directory).toBe('/private/host/path')
  expect(owner.body.title).toBe('a private title')

  // A wrong token gets the same public presence view as no token.
  const wrong = await request(app).get('/api/sessions/sess1').set('x-bridge-token', 'not-the-token')
  expect(wrong.body.directory).toBeUndefined()
  expect(wrong.body.title).toBeUndefined()
})
