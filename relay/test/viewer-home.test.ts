import { expect, test } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

/**
 * Where a viewer ends up when they land somewhere other than their session URL.
 *
 * The bare code-entry page is a dead end for someone who already holds a viewer
 * cookie: it renders with no session id, which disables the input — deliberately,
 * because a code alone must never be accepted. A viewer bounced to the root was
 * therefore shown a form they could not use, while the relay was holding their
 * cookie, which names the one session they are entitled to.
 *
 * The second half of this file is the reason that form is disabled at all: if a
 * code could be presented WITHOUT naming a session, guessing six characters
 * would be a search across every live share at once instead of an attack on one.
 */

async function shareAndJoin(app: ReturnType<typeof createApp>, id: string) {
  const created = await request(app)
    .post('/api/sessions')
    .send({ session_id: id, directory: '/work', title: 't' })
  expect(created.status).toBe(201)
  const activated = await request(app)
    .post('/api/activate')
    .send({ code: created.body.access_code, session_id: id })
  expect(activated.status).toBe(200)
  return {
    cookie: `viewer_token=${activated.body.viewer_token}`,
    code: created.body.access_code as string,
    bridgeToken: created.body.bridge_token as string,
  }
}

test('the root sends a known viewer back to their own share', async () => {
  const app = createApp(new Store())
  const { cookie } = await shareAndJoin(app, 'ses_home')

  const res = await request(app).get('/').set('Cookie', cookie)
  expect(res.status).toBe(302)
  expect(res.headers.location).toBe('/ses_home')
})

test('the code-entry page does the same rather than showing a form that cannot be used', async () => {
  const app = createApp(new Store())
  const { cookie } = await shareAndJoin(app, 'ses_home2')

  const res = await request(app).get('/join').set('Cookie', cookie)
  expect(res.status).toBe(302)
  expect(res.headers.location).toBe('/ses_home2')
})

test('with no cookie both still offer the generic page', async () => {
  const app = createApp(new Store())

  const root = await request(app).get('/')
  expect(root.status).toBe(302)
  expect(root.headers.location).toBe('/join')

  const join = await request(app).get('/join')
  expect(join.status).toBe(200)
  // No session id embedded -> the page disables its own input.
  expect(join.text).toContain('window.__OC_SESSION_ID__=null')
})

test('a cookie for a share that has ended is not treated as a home', async () => {
  const app = createApp(new Store())
  const { cookie, bridgeToken } = await shareAndJoin(app, 'ses_gone')
  await request(app).delete('/api/sessions/ses_gone').set('x-bridge-token', bridgeToken)

  // Nothing to route to any more, so the generic page is the honest answer.
  const res = await request(app).get('/').set('Cookie', cookie)
  expect(res.status).toBe(302)
  expect(res.headers.location).toBe('/join')
})

test('a forged cookie routes nowhere', async () => {
  const app = createApp(new Store())
  await shareAndJoin(app, 'ses_real')

  for (const cookie of ['viewer_token=not-a-real-token', 'viewer_token=', 'viewer_token=%zz']) {
    const res = await request(app).get('/').set('Cookie', cookie)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('/join')
  }
})

/**
 * The invariant the whole join flow rests on: an access code is only ever
 * checked against ONE named session. Accept a bare code and six characters
 * would unlock whichever live share happened to match — turning a per-share
 * lockout into a lottery across every share on the relay.
 */
test('a code alone can never activate anything', async () => {
  const app = createApp(new Store())
  const { code } = await shareAndJoin(app, 'ses_named')

  for (const body of [
    { code },
    { code, session_id: null },
    { code, session_id: '' },
    { code, session_id: '*' },
    { code, session_id: ['ses_named'] },
    { code, session_id: { id: 'ses_named' } },
    { code, session_id: 'ses_nameD' }, // one character off
  ]) {
    const res = await request(app).post('/api/activate').send(body as Record<string, unknown>)
    expect(res.status, JSON.stringify(body)).toBe(400)
    expect(res.body).toEqual({ error: 'invalid code' })
    expect(res.headers['set-cookie']).toBeUndefined()
  }

  // Naming the session correctly is what makes the very same code work.
  const ok = await request(app).post('/api/activate').send({ code, session_id: 'ses_named' })
  expect(ok.status).toBe(200)
})
