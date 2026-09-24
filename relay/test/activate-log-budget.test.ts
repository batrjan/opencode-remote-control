import { afterEach, expect, test, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'

/**
 * A code-guessing flood must not get to choose how much the relay logs.
 *
 * Every activation attempt wrote a line — the refusal, the per-share lock, the
 * full share — and nothing bounded how many. Activation is public and takes
 * only a session id and six characters, so the volume was the attacker's to
 * set: at nginx's edge rate that is a couple of lines a second per address,
 * more from more addresses, and each line carries an address that is itself
 * attacker-influenced text. The container half of this is docker's log
 * rotation (docker-compose.yml, compose-hardening.test.ts); this is the other
 * half, so rotation is not spent on noise the relay did not have to write.
 *
 * Budgeted like the bridge's own lifecycle log (BridgeClient.logLifecycle): a
 * cap per minute, the FIRST lines of a window kept — the ones that say an
 * attack started, and where from — and a count of what was dropped, so a gap
 * never reads as quiet.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

const SHARE = 'ses_logbudget00000000'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Every line the relay logged under the [activate] tag. */
function activateLines(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[activate]'))
}

test('a flood of guesses cannot choose how many lines the relay writes', async () => {
  const store = new Store()
  const app = createApp(store)
  store.createSession(SHARE, '/work', 't', '198.51.100.4')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  const attempts = 500
  for (let i = 0; i < attempts; i++) {
    const res = await request(app)
      .post('/api/activate')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ code: `BAD${String(i).padStart(3, '0')}`, session_id: SHARE })
    expect([400, 429]).toContain(res.status)
  }

  const lines = activateLines(warn)
  expect(lines.length, `${attempts} guesses wrote ${lines.length} lines`).toBeLessThan(attempts / 4)
  // The signal an operator needs survives: the start of the flood is in the
  // log, with the address that sent it.
  expect(lines[0]).toContain('203.0.113.9')
})

// A budget that logged nothing about its own silence would turn a flood into a
// quiet log, which is worse than a noisy one.
test('what the budget dropped is counted, not lost', async () => {
  const store = new Store()
  const app = createApp(store)
  store.createSession(SHARE, '/work', 't', '198.51.100.4')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  for (let i = 0; i < 500; i++) {
    await request(app)
      .post('/api/activate')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ code: `BAD${String(i).padStart(3, '0')}`, session_id: SHARE })
  }
  // One more, in a window of its own, to flush the count of the previous one.
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)
  await request(app)
    .post('/api/activate')
    .set('X-Forwarded-For', '203.0.113.9')
    .send({ code: 'BADLAST', session_id: SHARE })

  const summary = activateLines(warn).find((l) => /suppressed/i.test(l))
  expect(summary, 'nothing said how many lines were dropped').toBeDefined()
  expect(summary).toMatch(/\d+/)
})
