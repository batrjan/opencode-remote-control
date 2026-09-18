import { afterEach, expect, test, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'

/**
 * An [activate] line has to say WHICH share it is about.
 *
 * The log's budget and its per-share reserve are both kept per share, and the
 * reserve exists so that a share being ground is not silenced by a grinder
 * working on another one. But the lines themselves carried only the caller's
 * address, which an attacker picks — so the three lines the victim's reserve
 * bought were indistinguishable from the ninety-two the attacker wrote, and the
 * operator could not tell which share was under attack. Half the blind spot the
 * reserve closed was still open.
 *
 * The id is printed only for a REGISTERED share. /api/activate accepts any
 * string up to 128 bytes as session_id, so printing what the caller sent would
 * let anyone put a newline — and a forged "[activate] ..." line — into the
 * relay's log. A registered id has been through SESSION_ID_RE.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Every line the relay logged under the [activate] tag. */
function activateLines(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[activate]'))
}

const guess = (app: ReturnType<typeof createApp>, session_id: string, ip: string, code: string) =>
  request(app).post('/api/activate').set('X-Forwarded-For', ip).send({ code, session_id })

test('a rejected attempt names the share it was against, not only the address', async () => {
  const store = new Store()
  const app = createApp(store)
  store.createSession('ses_namedshare0001', '/work', 't', '198.51.100.5')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  expect((await guess(app, 'ses_namedshare0001', '203.0.113.9', 'BADCOD')).status).toBe(400)
  const [line] = activateLines(warn)
  console.log(`activate: ${line}`)
  expect(line, 'the line never says which share was being tried').toContain('share=ses_namedshare0001')
  // The address is the other half of the signal and stays.
  expect(line).toContain('ip=203.0.113.9')
})

test('a share that locks after five wrong codes names itself too', async () => {
  const store = new Store()
  const app = createApp(store)
  store.createSession('ses_lockedshare001', '/work', 't', '198.51.100.5')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  // Five consecutive wrong codes lock the share; the sixth is refused by the
  // lock itself, which is the line an operator is meant to find.
  for (let i = 0; i < 6; i++) await guess(app, 'ses_lockedshare001', '203.0.113.9', `BAD${String(i).padStart(3, '0')}`)
  const limited = activateLines(warn).filter((l) => l.includes('rate limited'))
  console.log(`activate: ${limited[0]}`)
  expect(limited.length, 'no rate-limited line at all').toBeGreaterThan(0)
  expect(limited[0], 'the lock line never says which share locked').toContain('share=ses_lockedshare001')
})

test('an id nobody registered is never printed, so a log line cannot be forged', async () => {
  const store = new Store()
  const app = createApp(store)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  // Anything up to 128 bytes reaches the handler, newlines included.
  const forged = 'ses_x\n[activate] rejected code attempt from ip=10.0.0.1'
  expect((await guess(app, forged, '203.0.113.9', 'BADCOD')).status).toBe(400)
  const lines = activateLines(warn)
  expect(lines.length, 'the attempt was not logged at all').toBe(1)
  console.log(`activate: ${JSON.stringify(lines[0])}`)
  expect(lines[0], "an unregistered caller's id reached the log").not.toContain('ses_x')
  expect(lines[0], 'a newline reached the log').not.toContain('\n')
  expect(lines[0], 'an id nobody registered was given a share tag').not.toContain('share=')
})
