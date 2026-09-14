import { expect, test } from 'vitest'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import request from 'supertest'
import { viewerTokenFrom } from './helpers/viewer-token'

// Session API requires the shared key; the failed-activation delay is a
// runtime brute-force brake and must not slow the test suite (both are read
// lazily from the env — see relay/src/config.ts).
const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY
process.env.ACTIVATE_FAIL_DELAY_MS = '0'

/**
 * Where the viewer token goes when a code is accepted.
 *
 * The token is the viewer's whole credential, and it is meant to live only in
 * the HttpOnly cookie, out of reach of any script. Activation set that cookie
 * but also returned the token in the JSON body, left over from a first design
 * that kept it in localStorage. Nothing reads it there: the join page checks
 * res.ok and navigates to /<id>, which authenticates by the cookie. So a
 * script running in the join page as the code was submitted could read the
 * victim's own token from the response, and use it without taking a seat or
 * moving the owner's viewer count, as minting a token of its own would.
 *
 * The body now names the session only. The cookie alone completes the join,
 * the /<id> redirect into the UI.
 */
test('POST /api/activate delivers the viewer token only as an HttpOnly cookie', async () => {
  const store = new Store()
  const app = createApp(store)
  const created = await request(app)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: 'ses_cookieonly', directory: '/path', title: 'title' })
  expect(created.status).toBe(201)

  const res = await request(app)
    .post('/api/activate')
    .send({ code: created.body.access_code, session_id: 'ses_cookieonly' })
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ session_id: 'ses_cookieonly' })

  const header = res.headers['set-cookie'] as unknown as string[]
  const cookie = header.find((c) => c.startsWith('viewer_token='))!
  expect(cookie).toMatch(/;\s*HttpOnly/i)
  expect(cookie).toMatch(/;\s*SameSite=Strict/i)
  const token = viewerTokenFrom(res)
  expect(store.verifyViewer('ses_cookieonly', token)).toBe(true)

  const redirect = await request(app).get('/ses_cookieonly').set('Cookie', `viewer_token=${token}`)
  expect(redirect.status).toBe(302)
})

test('POST /api/activate requires a session_id and binds the code to it', async () => {
  const store = new Store()
  const app = createApp(store)
  const { access_code } = store.createSession('sessA', '/path', 'title', 'test-ip')
  store.createSession('sessB', '/path', 'title', 'test-ip')
  // Missing session_id
  const noSession = await request(app).post('/api/activate').send({ code: access_code })
  expect(noSession.status).toBe(400)
  // Correct code, wrong session
  const wrongSession = await request(app)
    .post('/api/activate')
    .send({ code: access_code, session_id: 'sessB' })
  expect(wrongSession.status).toBe(400)
  expect(wrongSession.body.error).toBe('invalid code')
  // Correct pair
  const ok = await request(app).post('/api/activate').send({ code: access_code, session_id: 'sessA' })
  expect(ok.status).toBe(200)
  expect(ok.body.session_id).toBe('sessA')
})

test('POST /api/activate normalizes code case', async () => {
  const store = new Store()
  const app = createApp(store)
  const { access_code } = store.createSession('sess4', '/path', 'title', 'test-ip')
  const lowercased = access_code.toLowerCase()
  const res = await request(app).post('/api/activate').send({ code: lowercased, session_id: 'sess4' })
  expect(res.status).toBe(200)
  expect(res.body.session_id).toBe('sess4')
})

test('POST /api/activate rejects bad codes with a single error shape', async () => {
  const store = new Store()
  const app = createApp(store)
  // Same IP hits IP limit quickly; use distinct IPs to prove uniform shape for
  // unknown codes. Blocked-codes path is exercised in store unit tests.
  for (let i = 0; i < 10; i++) {
    const res = await request(app).post('/api/activate').send({ code: 'BADC0D', session_id: 'sessX' })
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
  expect(res.body.viewer_url).toBe('/sess1')
})

test('POST /api/activate delays wrong-code answers by the configured amount', async () => {
  process.env.ACTIVATE_FAIL_DELAY_MS = '150'
  try {
    const store = new Store()
    const app = createApp(store)
    const started = Date.now()
    const res = await request(app).post('/api/activate').send({ code: 'BADC0D', session_id: 'sessX' })
    const elapsed = Date.now() - started
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid code')
    expect(elapsed).toBeGreaterThanOrEqual(140) // 10ms slack for timer jitter
  } finally {
    process.env.ACTIVATE_FAIL_DELAY_MS = '0'
  }
})
