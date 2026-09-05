import { expect, test } from 'vitest'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import request from 'supertest'

test('POST /api/activate returns viewer_token', async () => {
  const store = new Store()
  const app = createApp(store)
  const { access_code } = store.createSession('sess1', '/path', 'title')
  const res = await request(app).post('/api/activate').send({ code: access_code })
  expect(res.status).toBe(200)
  expect(res.body.session_id).toBe('sess1')
  expect(res.body.viewer_token).toBeTruthy()
})

test('POST /api/activate rejects bad codes with a single error shape', async () => {
  const store = new Store()
  const app = createApp(store)
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
    .send({ session_id: 'sess1', directory: '/path', title: 'title' })
  expect(res.status).toBe(201)
  expect(res.body.session_id).toBe('sess1')
  expect(res.body.access_code).toMatch(/^[a-z0-9]{6}$/)
  expect(res.body.access_code).not.toMatch(/[01ol]/)
  expect(res.body.bridge_token).toBeTruthy()
  expect(res.body.viewer_url).toBe('/join')
})
