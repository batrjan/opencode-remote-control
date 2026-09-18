import { afterEach, expect, test, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'

/**
 * The [activate] log's per-share reserve must not be something a stranger can
 * OWN. activate-log-blinding.test.ts covers one noisy share against one quiet
 * one, and it passes for the wrong reason: with a single noisy share, fifteen
 * of the sixteen reserve slots are still free when the victim shows up.
 *
 * Registration is public, so slots are not scarce to an attacker: sixteen free
 * registrations take every slot on their FIRST line each, well before the
 * global budget is anywhere near spent, and made-up ids then finish the global
 * budget off (those get no reserve, by design). Every other share in the
 * process is then silent for the rest of the window — including the line
 * saying it had just locked after five wrong codes, which is the whole reason
 * the reserve exists. Measured before the fix: 60 attacker lines, 0 for the
 * victim, for 16 registrations and 76 activate attempts.
 *
 * So the rule cannot be first-come: a share that has not written in this window
 * takes its slot from whichever share has spent the most of its reserve.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

const VICTIM = 'ses_victimshare00000'
const VICTIM_IP = '198.51.100.77'
const ATTACK_IP = '203.0.113.9'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Every line the relay logged under the [activate] tag. */
function activateLines(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[activate]'))
}

const guess = (app: ReturnType<typeof createApp>, session_id: string, ip: string, code: string) =>
  request(app).post('/api/activate').set('X-Forwarded-For', ip).send({ code, session_id })

test('sixteen free registrations cannot own the reserve and blind a neighbour share', async () => {
  const store = new Store()
  const app = createApp(store)
  // The victim is an ordinary share somebody else owns.
  store.createSession(VICTIM, '/work', 't', '198.51.100.5')

  // Sixteen shares out of the PUBLIC registration endpoint — as many as there
  // are reserve slots. maxActiveSessionsPerIp is 5, so four addresses is the
  // whole cost of them.
  const mine: string[] = []
  for (let n = 0; n < 16; n++) {
    const id = `ses_attacker${String(n).padStart(8, '0')}`
    const res = await request(app)
      .post('/api/sessions')
      .set('X-Forwarded-For', `203.0.113.${20 + Math.floor(n / 5)}`)
      .send({ session_id: id, directory: '/tmp' })
    expect(res.status, `registration ${n} -> ${res.status} ${JSON.stringify(res.body)}`).toBe(201)
    mine.push(id)
  }

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  // One failed activate against each: sixteen lines, every one of them taking a
  // reserve slot while the global budget is still wide open.
  for (const id of mine) await guess(app, id, ATTACK_IP, 'BADCOD')
  expect(activateLines(warn).length, 'the sixteen shares did not each write a line').toBe(16)

  // Then made-up ids to finish the global budget.
  for (let i = 0; i < 60; i++) await guess(app, `ses_madeup${String(i).padStart(10, '0')}`, ATTACK_IP, 'BADCOD')
  const attackerLines = activateLines(warn).length

  // Now the victim share locks: five wrong codes in a row from another address.
  for (let i = 0; i < 10; i++) await guess(app, VICTIM, VICTIM_IP, `BAD${String(i).padStart(3, '0')}`)

  // By the SHARE, not the address: the address is the attacker's to choose, and
  // what the reserve is for is telling the operator which share is being ground.
  const victimLines = activateLines(warn)
    .slice(attackerLines)
    .filter((l) => l.includes(`share=${VICTIM}`))
  expect(
    victimLines.length,
    `the victim share left no trace at all (the attacker wrote ${attackerLines} lines with 16 registrations)`,
  ).toBeGreaterThan(0)
  // And the reserve stays a reserve: taking a slot back does not hand the
  // victim a second budget.
  expect(victimLines.length, 'the reserve is not a second budget').toBeLessThanOrEqual(3)
})
