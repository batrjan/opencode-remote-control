import { afterEach, expect, test, vi } from 'vitest'
import { Store } from '../src/store'

/**
 * A full claims map is a state the relay has to SAY it is in.
 *
 * When the map is full and no block is over-represented enough to take room
 * from, an ending share's id is simply not reserved for its owner (see
 * makeClaimRoom) — deliberately, because evicting a claim is how a flood used
 * to take an id from the install that holds it. But the refusal was silent in
 * every direction: the registrant is not told (their share is created; only the
 * reservation is missing), nothing is logged, and no counter moves. The first
 * sign is an owner discovering, days later, that a stranger registered the id
 * from their old link.
 *
 * And it is reachable: the concentration check means a block holding N claims
 * can only be taken from by a block already holding N, so ONE /24 that fills
 * the map freezes it — every honest registrant arrives with a smaller block
 * and is refused. That is the right call for the claims already recorded
 * (never evicted, whatever the volume — the assertion at the end here, and
 * claims-eviction.test.ts) and it is why the state has to be visible instead:
 * a log line and a counter an operator can alert on.
 */

const K_OWNER = 'owner-key-aaaaaaaaaaaaaaaaaaaaaa'
const K_ATT = 'attacker-key-bbbbbbbbbbbbbbbbbb'
const OWNER_IP = '198.51.100.7'
const EARLY = 'ses_ownerEARLYAAAAAAAAAA'
const LATE = 'ses_ownerLATEAAAAAAAAAAA'

afterEach(() => {
  vi.restoreAllMocks()
})

/** One registrant's full cycle: register, a bridge takes it up, it ends. */
function cycle(store: Store, id: string, ip: string, key: string): void {
  store.createSession(id, '/work', 't', ip, key)
  store.touchSession(id)
  store.deleteSession(id)
}

/** Whether `key` may register the id — i.e. whether the claim on it still holds. */
function canTake(store: Store, id: string, key: string): boolean {
  try {
    store.createSession(id, '/work', 't', '203.0.113.9', key)
    store.deleteSession(id)
    return true
  } catch (err) {
    if (err instanceof Error && err.message === 'session reserved') return false
    throw err
  }
}

/** Only the lines this state is supposed to write. */
function claimWarnings(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('claims map full'))
}

test('a reservation the full map turned away is logged and counted', () => {
  const store = new Store(8)
  // An owner shares a conversation before the flood: this claim is recorded.
  cycle(store, EARLY, OWNER_IP, K_OWNER)

  // One /24 fills the map — twice the cap, so every seat has been contested.
  for (let i = 0; i < 16; i++) cycle(store, `ses_flood${String(i).padStart(16, '0')}`, `203.0.113.${i + 1}`, K_ATT)

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  // The same owner shares a second conversation and ends it. Their block holds
  // fewer claims than the flood's, so nothing can be taken from it: the id goes
  // unreserved — silently, before this.
  cycle(store, LATE, OWNER_IP, K_OWNER)
  expect(canTake(store, LATE, K_ATT), 'the setup no longer reaches a refusal').toBe(true)

  expect(claimWarnings(warn).length, 'the relay recorded nothing about refusing a reservation').toBe(1)
  expect(claimWarnings(warn)[0]).toMatch(/not reserved|no longer reserved/)
  expect(store.claimStats().refused, 'the refusals are not counted').toBeGreaterThan(0)
  expect(store.claimStats().held, 'the map size is not reported').toBe(8)

  // Deduplicated: the state lasts as long as the map stays full, and a line per
  // refusal would be the flood writing the log.
  for (let i = 0; i < 20; i++) cycle(store, `ses_more${String(i).padStart(16, '0')}`, OWNER_IP, K_OWNER)
  expect(claimWarnings(warn).length, 'one line per refusal is a flood of its own').toBe(1)
  expect(store.claimStats().refused).toBeGreaterThan(1)

  // The positive control, unchanged: a claim already recorded is never handed
  // to somebody else, however full the map gets.
  expect(canTake(store, EARLY, K_ATT), 'a stranger took a reserved id').toBe(false)
})
