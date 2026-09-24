import { afterEach, expect, test, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'

/**
 * The [activate] budget bounds the volume a grinder can write. What it must not
 * do is let one grinder decide what the relay writes ABOUT EVERYONE ELSE.
 *
 * The budget was process-wide, while nginx's edge zone allows ~120 attempts a
 * minute PER ADDRESS: one address filling the window blinded every other share
 * in the process for the rest of it — including the line saying a neighbour's
 * share had just locked after five wrong codes, which is the one trace a
 * code-guessing attack leaves behind. Measured before the fix: 60 lines from
 * the noisy share, 0 from the victim.
 *
 * (The other half of the finding — the dropped-line count going missing when a
 * flood simply stops — is in activate-log-tail.test.ts, which needs a window of
 * its own and so a module of its own.)
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

const NOISE = 'ses_noiseshare000000'
const VICTIM = 'ses_victimshare00000'
const NOISE_IP = '203.0.113.9'
const VICTIM_IP = '198.51.100.77'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Every line the relay logged under the [activate] tag. */
function activateLines(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[activate]'))
}

const guess = (app: ReturnType<typeof createApp>, session_id: string, ip: string, code: string) =>
  request(app).post('/api/activate').set('X-Forwarded-For', ip).send({ code, session_id })

test('a flood against one share does not blind the log for another', async () => {
  const store = new Store()
  const app = createApp(store)
  store.createSession(NOISE, '/work', 't', '198.51.100.4')
  store.createSession(VICTIM, '/work', 't', '198.51.100.5')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  // One address grinding one share, at roughly the rate nginx lets through.
  for (let i = 0; i < 80; i++) await guess(app, NOISE, NOISE_IP, `BAD${String(i).padStart(3, '0')}`)
  const noise = activateLines(warn).length
  expect(noise, 'the noise did not fill the window').toBeGreaterThanOrEqual(30)

  // In the same window, a second address starts on a different share and locks
  // it — five wrong codes in a row, the event an operator has to be able to see.
  for (let i = 0; i < 10; i++) await guess(app, VICTIM, VICTIM_IP, `BAD${String(i).padStart(3, '0')}`)

  const victimLines = activateLines(warn)
    .slice(noise)
    .filter((l) => l.includes(VICTIM_IP))
  expect(victimLines.length, `the victim share left no trace at all (noise wrote ${noise} lines)`).toBeGreaterThan(0)
  // And the reserve is a reserve, not a second budget: it is small, and only a
  // share that exists gets one.
  expect(victimLines.length).toBeLessThanOrEqual(3)
})

// An id nobody registered costs nothing to invent, so a grinder naming a fresh
// one each time must not be able to spend the per-share reserve — that would
// hand back the blinding the reserve exists to stop.
test('made-up session ids get no reserve of their own', async () => {
  const store = new Store()
  const app = createApp(store)
  store.createSession(VICTIM, '/work', 't', '198.51.100.5')
  // The budget's window is module state, and the test above spent one. Move the
  // clock past it (as activate-log-budget.test.ts does) so this test starts on
  // a window of its own, with the whole budget and the whole reserve unspent.
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  for (let i = 0; i < 200; i++) await guess(app, `ses_madeup${String(i).padStart(12, '0')}`, NOISE_IP, 'BADCOD')
  const noise = activateLines(warn).length
  expect(noise, 'the guessing flood chose its own volume').toBeLessThanOrEqual(64)

  for (let i = 0; i < 10; i++) await guess(app, VICTIM, VICTIM_IP, `BAD${String(i).padStart(3, '0')}`)
  const victimLines = activateLines(warn)
    .slice(noise)
    .filter((l) => l.includes(VICTIM_IP))
  expect(victimLines.length, 'a flood of invented ids blinded a real share').toBeGreaterThan(0)
})
