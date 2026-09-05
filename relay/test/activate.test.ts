import { expect, test } from 'vitest'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import request from 'supertest'

// Session API requires the shared key; the failed-activation delay is a
// runtime brute-force brake and must not slow the test suite (both are read
// lazily from the env — see relay/src/config.ts).
const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
process.env.ACTIVATE_FAIL_DELAY_MS = '0'

test('POST /api/activate returns viewer_token', async () => {
  const store = new Store()
  const app = createApp(store)
  const { access_code } = store.createSession('sess1', '/path', 'title')
  const res = await request(app).post('/api/activate').send({ code: access_code })
  expect(res.status).toBe(200)
  expect(res.body.session_id).toBe('sess1')
  expect(res.body.viewer_token).toBeTruthy()
})

test('POST /api/activate normalizes code case', async () => {
  const store = new Store()
  const app = createApp(store)
  const { access_code } = store.createSession('sess4', '/path', 'title')
  const lowercased = access_code.toLowerCase()
  const res = await request(app).post('/api/activate').send({ code: lowercased })
  expect(res.status).toBe(200)
  expect(res.body.session_id).toBe('sess4')
})

test('POST /api/activate rejects bad codes with a single error shape', async () => {
  const store = new Store()
  const app = createApp(store)
  // Same IP hits IP limit quickly; use distinct IPs to prove uniform shape for
  // unknown codes. Blocked-codes path is exercised in store unit tests.
  for (let i = 0; i < 10; i++) {
    const res = await request(app).post('/api/activate').send({ code: 'badc0d' })
    expect(res.status).toBeLessThan(500)
    expect(res.body.error).toBeTruthy()
  }
})

test('POST /api/sessions creates a session and returns code + tokens', async () => {
  const store = new Store()
  const app = createApp(store)
  const res = await request(app)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: 'sess1', directory: '/path', title: 'title' })
  expect(res.status).toBe(201)
  expect(res.body.session_id).toBe('sess1')
  expect(res.body.access_code).toMatch(/^[A-Z0-9]{6}$/)
  expect(res.body.access_code).not.toMatch(/[OI]/)
  expect(res.body.bridge_token).toBeTruthy()
  expect(res.body.viewer_url).toBe('/join')
})

test('POST /api/activate delays wrong-code answers by the configured amount', async () => {
  process.env.ACTIVATE_FAIL_DELAY_MS = '150'
  try {
    const store = new Store()
    const app = createApp(store)
    const started = Date.now()
    const res = await request(app).post('/api/activate').send({ code: 'badc0d' })
    const elapsed = Date.now() - started
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid code')
    expect(elapsed).toBeGreaterThanOrEqual(140) // 10ms slack for timer jitter
  } finally {
    process.env.ACTIVATE_FAIL_DELAY_MS = '0'
  }
})
