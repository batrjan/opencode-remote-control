import { expect, test } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { noteSwallowed } from '../src/faults'

/**
 * /health is public — nginx serves it from the general `location /`, there is
 * no `location = /health` — and the swallowed-fault counter it now carries is
 * an oracle if anyone may read it: send a probe, read the counter, and you know
 * whether YOUR request reached a handler that threw. The defects it points at
 * are exactly the ones the swallowing exists to survive, in a process that
 * serves every tenant's share.
 *
 * So the counter goes to the operator's side only. The discriminator is not a
 * secret (RELAY_API_KEY is read by nothing and defaults to empty) but the path
 * the request took: nginx appends the client to X-Forwarded-For on everything
 * it proxies, so a request carrying that header came through the public edge,
 * whatever it claims to be. The documented operator paths carry none — the
 * image's HEALTHCHECK from inside the container, and `curl 127.0.0.1:8080/health`
 * on the host (DEPLOY.md) — and the port is published on 127.0.0.1 only, so
 * nothing off the host can be a peer here in the first place.
 *
 * Everything else about the probe is unchanged: same status, same fields, so
 * the compose probe, `bridge status` and a monitor reading the old body are
 * untouched (health.test.ts pins that shape).
 */

test('the fault counter is not part of the public probe body', async () => {
  const app = createApp(new Store())

  const before = await request(app).get('/health').set('X-Forwarded-For', '203.0.113.9')
  expect(before.status).toBe(200)
  expect(before.body.healthy).toBe(true)

  // A request of the caller's own crashes a handler somewhere.
  noteSwallowed()

  const after = await request(app).get('/health').set('X-Forwarded-For', '203.0.113.9')
  expect(after.status).toBe(200)
  expect(after.body.faults, 'an anonymous caller can read the swallowed-fault counter').toBeUndefined()
  expect(
    JSON.stringify(after.body),
    'the public probe body moved when a handler threw, which is the oracle',
  ).toBe(JSON.stringify(before.body))
})

test('the operator side still reads the counter', async () => {
  const app = createApp(new Store())
  // No X-Forwarded-For: the HEALTHCHECK inside the container and the operator's
  // curl on the host both reach the relay without passing nginx.
  const res = await request(app).get('/health')
  expect(res.status).toBe(200)
  expect(res.body.faults, '/health no longer reports faults to the operator').toBeDefined()
  expect(res.body.faults.swallowed, 'the counter does not count').toBeGreaterThan(0)
})
