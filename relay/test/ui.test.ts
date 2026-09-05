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
