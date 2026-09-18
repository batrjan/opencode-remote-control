import { expect, test } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { config } from '../src/config'

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

/**
 * What an anonymous caller can make the relay remember.
 *
 * POST /api/activate is public: it has to be, it is how a viewer holding a
 * link and a code gets in. A wrong guess is recorded against the session it
 * named (the per-session failure lock), keyed by that session id — the one
 * tracking map keyed by text the caller wrote rather than a hash of it. The id
 * used to be checked only for being a non-empty string, while the body limit
 * on public endpoints is 32 KB. So every wrong guess naming a DIFFERENT
 * made-up ~32,000-character id pinned ~32 KB of heap that nothing ever freed
 * (no later success clears a session that does not exist, and the orphan
 * reaper only walks real sessions). The only bound was the FIFO cap on the
 * tracking maps — 100,000 entries, ~3 GB — reachable with no valid share, no
 * code and no account, one small request at a time.
 *
 * Registration already refuses a session id longer than 128 characters, so no
 * session that could ever be activated has a longer one: activation now refuses
 * it up front, before anything is recorded, with the same answer as any other
 * bad attempt.
 */

const sessionFailKeys = (store: Store) =>
  [...(store as unknown as { sessionFails: Map<string, unknown> }).sessionFails.keys()]

test('an over-long session id is refused without being remembered', async () => {
  const store = new Store()
  const app = createApp(store)

  // Just past the registration bound, and near the public body cap — the size
  // an attacker actually sends. Distinct ids, as a real fill would use.
  const ids = ['a'.repeat(200), 'b'.repeat(30_000), `ses_${'c'.repeat(30_000)}`]
  for (const id of ids) {
    const res = await request(app).post('/api/activate').send({ code: 'ABCDEF', session_id: id })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid code')
  }

  // Compared by length so a failure prints [200, 30000, 30004], not 60 KB of ids.
  expect(sessionFailKeys(store).map((key) => key.length)).toEqual([])
})

test('a session id at the registration bound still activates and still locks', async () => {
  const store = new Store()
  const app = createApp(store)

  // The longest id registration accepts must remain usable end to end.
  const id = `ses_${'x'.repeat(124)}`
  expect(id.length).toBe(128)
  const created = await request(app)
    .post('/api/sessions')
    .send({ session_id: id, directory: '/work', title: 't' })
  expect(created.status).toBe(201)
  const { access_code } = created.body as { access_code: string }

  const ok = await request(app).post('/api/activate').send({ code: access_code, session_id: id })
  expect(ok.status).toBe(200)
  expect(ok.body.session_id).toBe(id)

  // The per-session brute-force brake is untouched: consecutive wrong guesses
  // against a real share still lock it, correct code included.
  for (let i = 0; i < config.sessionFailLockThreshold; i++) {
    const miss = await request(app)
      .post('/api/activate')
      .send({ code: `WRONG${i}`, session_id: id })
    expect(miss.status).toBe(400)
  }
  expect(sessionFailKeys(store)).toEqual([id])
  const locked = await request(app).post('/api/activate').send({ code: access_code, session_id: id })
  expect(locked.status).toBe(429)
})
