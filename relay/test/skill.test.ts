import { expect, test } from 'vitest'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import request from 'supertest'

/**
 * Bridge-facing session API security: x-api-key auth on every route,
 * 409 on duplicate session ids, DELETE lifecycle endpoint.
 * The key is read lazily from RELAY_API_KEY (see relay/src/config.ts),
 * so setting it here at module scope is enough.
 */
const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
// One test activates a revoked code: keep the failed-attempt delay out of it.
process.env.ACTIVATE_FAIL_DELAY_MS = '0'

test('POST /api/sessions without x-api-key is 401', async () => {
  const app = createApp(new Store())
  const res = await request(app)
    .post('/api/sessions')
    .send({ session_id: 'sess1', directory: '/path', title: 'title' })
  expect(res.status).toBe(401)
})

test('POST /api/sessions with a wrong x-api-key is 401', async () => {
  const app = createApp(new Store())
  const res = await request(app)
    .post('/api/sessions')
    .set('x-api-key', 'wrong-key')
    .send({ session_id: 'sess1', directory: '/path', title: 'title' })
  expect(res.status).toBe(401)
})

test('POST /api/sessions with the key creates the session', async () => {
  const app = createApp(new Store())
  const res = await request(app)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
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
    .set('x-api-key', API_KEY)
    .send({ session_id: 'sess1', directory: '/path', title: 'title' })
  expect(first.status).toBe(201)
  const res = await request(app)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: 'sess1', directory: '/other', title: 'takeover' })
  expect(res.status).toBe(409)
  expect(res.body.error).toBeTruthy()
  // The original session (and its code) must be untouched.
  expect(store.getSession('sess1')?.directory).toBe('/path')
})

test('DELETE /api/sessions/:id without x-api-key is 401', async () => {
  const store = new Store()
  store.createSession('sess1', '/path', 'title')
  const app = createApp(store)
  const res = await request(app).delete('/api/sessions/sess1')
  expect(res.status).toBe(401)
  expect(store.getSession('sess1')).toBeTruthy()
})

test('DELETE /api/sessions/:id with a wrong x-api-key is 401', async () => {
  const store = new Store()
  store.createSession('sess1', '/path', 'title')
  const app = createApp(store)
  const res = await request(app).delete('/api/sessions/sess1').set('x-api-key', 'wrong-key')
  expect(res.status).toBe(401)
  expect(store.getSession('sess1')).toBeTruthy()
})

test('DELETE /api/sessions/:id with the key removes the session (204) and revokes the code', async () => {
  const store = new Store()
  const { access_code } = store.createSession('sess1', '/path', 'title')
  const app = createApp(store)
  const res = await request(app).delete('/api/sessions/sess1').set('x-api-key', API_KEY)
  expect(res.status).toBe(204)
  expect(store.getSession('sess1')).toBeUndefined()
  // The access code is revoked with the session.
  const activated = await request(app).post('/api/activate').send({ code: access_code, session_id: 'sess1' })
  expect(activated.status).toBe(400)
})

test('DELETE /api/sessions/:id on an unknown session is 404', async () => {
  const app = createApp(new Store())
  const res = await request(app).delete('/api/sessions/nope').set('x-api-key', API_KEY)
  expect(res.status).toBe(404)
})

test('GET /api/sessions/:id returns non-secret session info (and enforces auth)', async () => {
  const store = new Store()
  store.createSession('sess1', '/path', 'title')
  const app = createApp(store)
  const unauth = await request(app).get('/api/sessions/sess1')
  expect(unauth.status).toBe(401)
  const res = await request(app).get('/api/sessions/sess1').set('x-api-key', API_KEY)
  expect(res.status).toBe(200)
  expect(res.body.session_id).toBe('sess1')
  expect(res.body.directory).toBe('/path')
  expect(res.body.title).toBe('title')
  // No secret material may leak through the status endpoint.
  expect(res.body.access_code).toBeUndefined()
  expect(res.body.bridge_token).toBeUndefined()
  expect(res.body.code_hash).toBeUndefined()
  expect(res.body.bridge_token_hash).toBeUndefined()
  const missing = await request(app).get('/api/sessions/nope').set('x-api-key', API_KEY)
  expect(missing.status).toBe(404)
})
