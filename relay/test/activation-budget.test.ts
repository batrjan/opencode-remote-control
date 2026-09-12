import { expect, test, vi, afterEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { config } from '../src/config'

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

afterEach(() => {
  vi.useRealTimers()
})

/**
 * What stops someone guessing an access code.
 *
 * There is deliberately no per-ADDRESS limit on activation attempts. An address
 * costs nothing to change, so it throttled the wrong people — a team behind one
 * office NAT shares a single bucket, and the sixth colleague to enter a
 * perfectly good code was told "too many attempts" — while a determined
 * attacker simply spread the grind across addresses and never noticed it.
 *
 * The brake is per SESSION and consecutive: five failures in a row against one
 * share lock activation for that share for 15 minutes, regardless of where the
 * attempts came from. An attacker cannot escape it by changing address, because
 * they cannot change which share they are attacking.
 *
 * The cost lands on accidents rather than attackers, and it is real: while
 * locked, activation is refused for EVERYONE, correct code included. That is
 * not an oversight — admitting a correct code during a lockout would let a
 * distributed attacker keep guessing at full speed and win on a lucky try,
 * which is the whole thing the lockout prevents. Counting consecutively is what
 * keeps it tolerable: one person's typo is forgotten the moment anyone gets in.
 */

const OFFICE = '198.51.100.20'

async function share(app: ReturnType<typeof createApp>, id: string) {
  const created = await request(app)
    .post('/api/sessions')
    .send({ session_id: id, directory: '/work', title: 't' })
  expect(created.status).toBe(201)
  return created.body as { access_code: string; bridge_token: string }
}

const activate = (app: ReturnType<typeof createApp>, id: string, code: string, ip: string) =>
  request(app).post('/api/activate').set('X-Forwarded-For', ip).send({ code, session_id: id })

test('a whole office behind one address can join the same share', async () => {
  const app = createApp(new Store())
  const { access_code } = await share(app, 'ses_office')

  // Far more joins from one address than any per-address limit would have
  // allowed, every one of them a correct code: a team opening the link a
  // colleague sent. Nothing throttles a caller who knows the code.
  const joins = 20
  const tokens = new Set<string>()
  for (let i = 0; i < joins; i++) {
    const res = await activate(app, 'ses_office', access_code, OFFICE)
    expect(res.status).toBe(200)
    tokens.add(res.body.viewer_token)
  }
  expect(tokens.size).toBe(joins)
})

test('five wrong codes in a row lock the share, whatever address they come from', async () => {
  const app = createApp(new Store())
  const { access_code } = await share(app, 'ses_grind')

  // Every guess from a different address — the spread that used to defeat a
  // per-address limit entirely. It buys nothing here.
  const statuses: number[] = []
  for (let i = 0; i < config.sessionFailLockThreshold; i++) {
    statuses.push((await activate(app, 'ses_grind', `ZZZZ${String(i).padStart(2, '0')}`, `203.0.113.${i + 1}`)).status)
  }
  expect(statuses).toEqual(Array.from({ length: config.sessionFailLockThreshold }, () => 400))

  // Locked: the next guess is refused without being evaluated...
  expect((await activate(app, 'ses_grind', 'ZZZZ99', '203.0.113.99')).status).toBe(429)
  // ...and so is the correct code, from an address that never failed. This is
  // the deliberate cost: admitting it would reopen the door the lock just shut.
  expect((await activate(app, 'ses_grind', access_code, '198.51.100.77')).status).toBe(429)
})

test('the count is consecutive: anyone getting in resets it', async () => {
  const app = createApp(new Store())
  const { access_code } = await share(app, 'ses_reset')

  // Four wrong — one short of the lock.
  for (let i = 0; i < config.sessionFailLockThreshold - 1; i++) {
    expect((await activate(app, 'ses_reset', `NO${i}`, OFFICE)).status).toBe(400)
  }
  // Somebody joins successfully, which clears the run.
  expect((await activate(app, 'ses_reset', access_code, OFFICE)).status).toBe(200)
  // So four more typos still do not lock the share...
  for (let i = 0; i < config.sessionFailLockThreshold - 1; i++) {
    expect((await activate(app, 'ses_reset', `NO2${i}`, OFFICE)).status).toBe(400)
  }
  // ...and a colleague with the right code is unaffected.
  expect((await activate(app, 'ses_reset', access_code, OFFICE)).status).toBe(200)
})

test('the lock is per share: grinding one does not touch another', async () => {
  const app = createApp(new Store())
  const a = await share(app, 'ses_target')
  const b = await share(app, 'ses_bystander')

  for (let i = 0; i < config.sessionFailLockThreshold; i++) {
    expect((await activate(app, 'ses_target', `NO${i}`, OFFICE)).status).toBe(400)
  }
  expect((await activate(app, 'ses_target', a.access_code, OFFICE)).status).toBe(429)
  // The share next door is untouched — same address, same moment.
  expect((await activate(app, 'ses_bystander', b.access_code, OFFICE)).status).toBe(200)
})

test('the lock lifts on its own after the window', async () => {
  vi.useFakeTimers()
  const store = new Store()
  const { access_code } = store.createSession('ses_window', '/work', 't', OFFICE)

  for (let i = 0; i < config.sessionFailLockThreshold; i++) {
    expect(() => store.activate(`NO${i}`, 'ses_window')).toThrow('invalid code')
  }
  expect(() => store.activate(access_code, 'ses_window')).toThrow('rate limited')

  // Nothing has to happen for the share to recover: the window simply passes.
  vi.setSystemTime(Date.now() + config.sessionFailLockMs + 1000)
  expect(store.activate(access_code, 'ses_window').viewer_token).toBeTruthy()
})

test('a lockout caps guessing far below what the code space needs', () => {
  // The number that makes five-in-a-row safe rather than merely tidy: the
  // lockout admits sessionFailLockThreshold guesses per sessionFailLockMs, and
  // the code is codeLength characters from codeAlphabet.
  const perDay = (config.sessionFailLockThreshold * 86_400_000) / config.sessionFailLockMs
  const space = Math.pow(config.codeAlphabet.length, config.codeLength)
  const yearsToHalf = space / 2 / perDay / 365
  expect(perDay).toBeLessThanOrEqual(500)
  // ~4,400 years to an even chance. Not "millions", which is what this
  // assertion exists to stop anyone (including a future comment) from claiming.
  expect(yearsToHalf).toBeGreaterThan(1_000)
})
