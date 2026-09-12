import { expect, test } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { config } from '../src/config'

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

/**
 * Who pays for the per-address activation budget.
 *
 * The limit exists to throttle code GRINDING, and grinding is made of wrong
 * guesses — so wrong guesses are what it charges for. It used to charge every
 * attempt, including correct ones, and the whole cost of that landed on
 * legitimate users: the limit keys on the client ADDRESS, and one address is
 * a whole office behind a NAT. The sixth colleague to enter the same share's
 * code within a minute was told "too many attempts" while holding a perfectly
 * good code. Measured against the live relay before this changed.
 *
 * These tests pin both halves: the office gets in, the grinder does not.
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

  // Four times the old per-minute ceiling, every one of them a correct code,
  // all from a single address — a team opening the link their colleague sent.
  const joins = config.ipLimitPerMinute * 4
  const tokens = new Set<string>()
  for (let i = 0; i < joins; i++) {
    const res = await activate(app, 'ses_office', access_code, OFFICE)
    expect(res.status).toBe(200)
    tokens.add(res.body.viewer_token)
  }
  // Distinct viewers, not one token handed out repeatedly.
  expect(tokens.size).toBe(joins)
})

test('a grinder on the same address is still cut off at the limit', async () => {
  const app = createApp(new Store())
  await share(app, 'ses_grind')

  const statuses: number[] = []
  for (let i = 0; i <= config.ipLimitPerMinute; i++) {
    // A DIFFERENT wrong code each time, so the per-code block (10 tries) does
    // not fire first and the address budget is what answers.
    const res = await activate(app, 'ses_grind', `ZZZZ${String(i).padStart(2, '0')}`, '203.0.113.44')
    statuses.push(res.status)
  }
  expect(statuses.slice(0, config.ipLimitPerMinute)).toEqual(
    Array.from({ length: config.ipLimitPerMinute }, () => 400),
  )
  expect(statuses[config.ipLimitPerMinute]).toBe(429)
})

test("one colleague's typos do not lock out everyone else on the address", async () => {
  const app = createApp(new Store())
  const { access_code } = await share(app, 'ses_typos')

  // Somebody burns the entire per-minute budget on wrong codes...
  for (let i = 0; i < config.ipLimitPerMinute; i++) {
    expect((await activate(app, 'ses_typos', `WRONG${i}`, OFFICE)).status).toBe(400)
  }
  // ...and the next wrong guess from that address is refused, as it should be.
  expect((await activate(app, 'ses_typos', 'WRONGX', OFFICE)).status).toBe(429)
  // But a colleague with the RIGHT code is not collateral damage.
  const good = await activate(app, 'ses_typos', access_code, OFFICE)
  expect(good.status).toBe(200)
  expect(typeof good.body.viewer_token).toBe('string')
})

test('spamming an already-blocked code still costs the address its budget', async () => {
  // This path short-circuits before the hash compare. Leaving it free would
  // let an attacker hammer a code they already know is dead without ever
  // touching their budget.
  const app = createApp(new Store())
  await share(app, 'ses_blocked')
  const ip = '203.0.113.77'
  const CODE = 'BADBAD'

  // Block the code from spread-out addresses so the block, not the budget, is
  // what the attacker then runs into.
  for (let i = 0; i < config.codeFailBlockThreshold; i++) {
    expect((await activate(app, 'ses_blocked', CODE, `192.0.2.${i + 1}`)).status).toBe(400)
  }
  const statuses: number[] = []
  for (let i = 0; i <= config.ipLimitPerMinute; i++) {
    statuses.push((await activate(app, 'ses_blocked', CODE, ip)).status)
  }
  expect(statuses[config.ipLimitPerMinute]).toBe(429)
})

test('the per-session lockout is unchanged and still address-independent', async () => {
  // The defence that actually matters against a distributed grind: it counts
  // failures per SESSION, so spreading the attempts over many addresses buys
  // an attacker nothing.
  const app = createApp(new Store())
  const { access_code } = await share(app, 'ses_locked')

  for (let i = 0; i < config.sessionFailLockThreshold; i++) {
    // Every attempt from its own address, and a fresh wrong code each time.
    const res = await activate(app, 'ses_locked', `NO${String(i).padStart(4, '0')}`, `203.0.${i + 1}.9`)
    expect(res.status).toBe(400)
  }
  // The session is locked now — even the correct code, even from an address
  // that has never failed, is refused for the lockout window.
  const res = await activate(app, 'ses_locked', access_code, '198.51.100.200')
  expect(res.status).toBe(429)
})
