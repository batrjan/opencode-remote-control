import { afterEach, expect, test, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'

/**
 * What a window dropped has to be said even if nothing is ever sent again.
 *
 * The count of suppressed lines was printed by the NEXT line the relay wrote,
 * so a flood that simply stopped — a hit and run, or a grinder that moved on —
 * took its own count with it: 200 attempts left exactly 60 lines and not one
 * word about the rest. A gap in a log reads as nothing having happened, which
 * is the worse thing to hand an operator.
 *
 * Its own file: the budget's window is module state, and the test that shows
 * one grinder blinding another share (activate-log-blinding.test.ts) needs a
 * window that has not been wound forward.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

const SHARE = 'ses_tailshare0000000'
const IP = '203.0.113.9'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const guess = (app: ReturnType<typeof createApp>, code: string) =>
  request(app).post('/api/activate').set('X-Forwarded-For', IP).send({ code, session_id: SHARE })

test('the count of what was dropped is flushed even if the flood stops', async () => {
  const store = new Store()
  const app = createApp(store)
  store.createSession(SHARE, '/work', 't', '198.51.100.4')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const lines = () => warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[activate]'))

  // Lock the share first, on real timers: past the lock every attempt is
  // refused as 'rate limited' and answered with no wrong-code delay, so the
  // flood below needs no timer of its own to make progress.
  for (let i = 0; i < 6; i++) await guess(app, `BAD${String(i).padStart(3, '0')}`)

  vi.useFakeTimers()
  for (let i = 0; i < 300; i++) await guess(app, `BAD${String(i).padStart(3, '0')}`)
  expect(lines().some((l) => /suppressed/i.test(l)), 'the tail was printed before the window closed').toBe(false)

  // Nothing further is sent: the window has to close itself.
  await vi.advanceTimersByTimeAsync(61_000)
  const summary = lines().find((l) => /suppressed/i.test(l))
  expect(summary, 'a flood that stopped left no record of what was dropped').toBeDefined()
  expect(summary).toMatch(/\d+/)
})
