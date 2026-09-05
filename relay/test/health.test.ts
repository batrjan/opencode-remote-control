import { afterAll, beforeAll, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'
import request from 'supertest'
import { startServer } from '../src/server'

/**
 * /health is the relay's only unauthenticated liveness surface: the Docker
 * HEALTHCHECK, the compose healthcheck and `bridge status` all probe it.
 * These tests pin its shape (ok/healthy/sessions/version) through the full
 * server (WS bridge + proxy adapter mounted), on an ephemeral port so the
 * suite never collides with a dev relay on 8080.
 */

// The session API requires the shared relay key (read lazily from the env).
const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY

let server: Server

beforeAll(async () => {
  server = await startServer(0)
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

test('GET /health', async () => {
  const res = await request(server).get('/health')
  expect(res.status).toBe(200)
  expect(res.body.healthy).toBe(true)
  expect(res.body.ok).toBe(true)
  expect(res.body.sessions).toBeTypeOf('number')
  // Version must be the real package version, not a hardcoded constant.
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  )
  expect(res.body.version).toBe(pkg.version)
})

test('GET /health reflects the live session count', async () => {
  const before = (await request(server).get('/health')).body.sessions
  const created = await request(server)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: 'health-sess', directory: '/path', title: 'title' })
  expect(created.status).toBe(201)
  const res = await request(server).get('/health')
  expect(res.status).toBe(200)
  expect(res.body.sessions).toBe(before + 1)
})

test('GET /health requires no auth and leaks no secrets', async () => {
  const res = await request(server).get('/health')
  expect(res.status).toBe(200)
  const body = JSON.stringify(res.body)
  expect(body).not.toContain(API_KEY)
  expect(body).not.toContain('token')
})
