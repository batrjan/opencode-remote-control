import { expect, test } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'

test('GET /join returns HTML with a code input', async () => {
  const app = createApp(new Store())
  const res = await request(app).get('/join')
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toContain('text/html')
  expect(res.text).toContain('<input')
})

test('GET /terminal serves the opencode web UI', async () => {
  const app = createApp(new Store())
  const res = await request(app).get('/terminal')
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toContain('text/html')
  expect(res.text).toContain('<div id="root"')
})

test('GET / redirects to /join', async () => {
  const app = createApp(new Store())
  const res = await request(app).get('/')
  expect(res.status).toBe(302)
  expect(res.headers.location).toBe('/join')
})

/**
 * An unknown session used to answer a bare "<h1>Session not found</h1>",
 * which is what viewers hit whenever a share ended — including, before
 * sessions were persisted, on every relay redeploy. Explain it instead.
 */
test('an unknown session gets an explanatory ended page, not a bare 404 line', async () => {
  for (const url of [
    '/ses_doesnotexist000000000',
    '/L1VzZXJz/session/ses_doesnotexist000000000',
    '/server/aHR0cA/session/ses_doesnotexist000000000',
  ]) {
    const res = await request(createApp(new Store())).get(url)
    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.text).toContain('This session has ended')
    expect(res.text).toContain('/remote-control/start')
    expect(res.text).not.toContain('Session not found')
  }
})
