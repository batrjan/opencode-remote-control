import { expect, test } from 'vitest'
import { Store } from '../src/store'

/**
 * A registration flood must not be able to take an id its owner still holds.
 *
 * When a keyed share ends, its id stays reserved for the install that shared
 * it (Store.recordClaim) for config.ownerClaimTtlMs — 30 days — because the id
 * is public: it is in the share link, and the owner registers it again every
 * time they share that conversation. The claims live in one bounded map, and
 * that map used to evict the OLDEST entry when it filled. So the reservation
 * was not decided by the owner_key at all past the cap: anyone willing to
 * register, connect and delete enough sessions pushed the oldest claim out,
 * and the id behind it was theirs to take and hold for another 30 days.
 *
 * Eviction is bucketed by the registrant's address block now: a claim is
 * displaced only by the block that is over-represented in the map, which under
 * a flood is the flooder's own. Nothing is displaced at all when the map is as
 * evenly spread as the cap allows — a new claim is simply not recorded, which
 * is what the relay did before reservations existed. The cap itself is
 * untouched: the map never holds more than maxTrackingEntries.
 *
 * The store is built with a tiny cap (8) so the flood is 16 cycles, not
 * 100 000. A cycle is what a real registrant does: register with a key, bring
 * a bridge up (touchSession — a registration no bridge took up reserves
 * nothing), then end it.
 */

const VICTIM = 'ses_victimAAAAAAAAAAAAAA'
const K_OWNER = 'owner-key-aaaaaaaaaaaaaaaaaaaaaa'
const K_ATT = 'attacker-key-bbbbbbbbbbbbbbbbbb'
const OWNER_IP = '198.51.100.7'

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

test('a flood from one address block cannot evict an owner reservation', () => {
  const store = new Store(8)
  cycle(store, VICTIM, OWNER_IP, K_OWNER)
  // Sixteen ended shares from one /24 — twice the cap, so every seat in the
  // map has been contested.
  for (let i = 0; i < 16; i++) cycle(store, `ses_flood${String(i).padStart(16, '0')}`, `203.0.113.${i + 1}`, K_ATT)
  expect(canTake(store, VICTIM, K_ATT), 'a stranger took the reserved id').toBe(false)
})

test('nor a flood spread over one address block per registration', () => {
  const store = new Store(8)
  cycle(store, VICTIM, OWNER_IP, K_OWNER)
  for (let i = 0; i < 16; i++) cycle(store, `ses_spread${String(i).padStart(15, '0')}`, `203.0.${i + 1}.4`, K_ATT)
  expect(canTake(store, VICTIM, K_ATT), 'a stranger took the reserved id').toBe(false)
})

/**
 * The case the two tests above miss: in both of them the owner holds exactly
 * ONE claim, so their block is never the largest and never the victim. An owner
 * who shared two conversations in a row — or an office where several people
 * share from behind one NAT — holds several claims in one block, and a flood
 * that spends a fresh block per registration holds one claim in each of many.
 * Picking the LARGEST bucket then picks the honest block every time, and the
 * flood's own size-1 blocks are un-evictable by construction.
 *
 * IPv6 is the cheap side of this: a /64 per cycle costs an attacker nothing.
 */
test('nor a flood that spends one address block per registration, against an owner who shared twice', () => {
  const store = new Store(4)
  const mine = ['ses_mineAAAAAAAAAAAAAAAA', 'ses_mineBBBBBBBBBBBBBBBB']
  for (const id of mine) cycle(store, id, OWNER_IP, K_OWNER) // one /24 between them
  for (let i = 0; i < 12; i++) cycle(store, `ses_v6flood${String(i).padStart(14, '0')}`, `2001:db8:0:${i}::1`, K_ATT)
  expect(mine.filter((id) => canTake(store, id, K_ATT)), 'a spread flood took a reserved id').toEqual([])
})

// The other half of the same invariant: to take room from a block holding N
// claims you must already hold N yourself, so a flood must concentrate to
// displace anybody — and concentrating is what the bucketing already answers.
test('a flood cannot take room from a block more concentrated than its own', () => {
  const store = new Store(4)
  const mine = ['ses_mineAAAAAAAAAAAAAAAA', 'ses_mineBBBBBBBBBBBBBBBB', 'ses_mineCCCCCCCCCCCCCCCC']
  for (const id of mine) cycle(store, id, OWNER_IP, K_OWNER)
  // Two from one block, then singletons: neither shape reaches three.
  cycle(store, 'ses_pairAAAAAAAAAAAAAAAA', '203.0.113.1', K_ATT)
  cycle(store, 'ses_pairBBBBBBBBBBBBBBBB', '203.0.113.2', K_ATT)
  for (let i = 0; i < 8; i++) cycle(store, `ses_oneoff${String(i).padStart(15, '0')}`, `2001:db8:1:${i}::1`, K_ATT)
  expect(mine.filter((id) => canTake(store, id, K_ATT)), 'a stranger took a reserved id').toEqual([])
})

test('the owner still gets their own id back, and the map stays bounded', () => {
  const store = new Store(8)
  cycle(store, VICTIM, OWNER_IP, K_OWNER)
  for (let i = 0; i < 16; i++) cycle(store, `ses_flood${String(i).padStart(16, '0')}`, `203.0.113.${i + 1}`, K_ATT)
  // The reservation is for the owner, not against everyone.
  const again = store.createSession(VICTIM, '/work', 't', OWNER_IP, K_OWNER)
  expect(again.session_id).toBe(VICTIM)
  // The point of the cap is that the map cannot grow without limit.
  const claims = store.snapshot().claims ?? []
  expect(claims.length).toBeLessThanOrEqual(8)
})

test('a claim survives a restart, and a flood after it still cannot evict it', () => {
  const first = new Store(8)
  cycle(first, VICTIM, OWNER_IP, K_OWNER)
  const state = first.snapshot()
  expect(state.claims?.[0]?.bucket, 'the claim carries its block').toBeTypeOf('string')

  const second = new Store(8)
  second.restore(state)
  for (let i = 0; i < 16; i++) cycle(second, `ses_flood${String(i).padStart(16, '0')}`, `203.0.113.${i + 1}`, K_ATT)
  expect(canTake(second, VICTIM, K_ATT), 'a stranger took the reserved id after a restart').toBe(false)
})

// A plaintext state file carries no bucket (it is stripped with the owner IP it
// comes from), and neither does a file written by an older relay.
test('and after a restart from a file that carries no address block at all', () => {
  const first = new Store(8)
  cycle(first, VICTIM, OWNER_IP, K_OWNER)
  const state = first.snapshot()
  state.claims = (state.claims ?? []).map(({ bucket: _b, ...rest }) => rest)

  const second = new Store(8)
  second.restore(state)
  for (let i = 0; i < 16; i++) cycle(second, `ses_flood${String(i).padStart(16, '0')}`, `203.0.113.${i + 1}`, K_ATT)
  expect(canTake(second, VICTIM, K_ATT), 'a stranger took the reserved id after a restart').toBe(false)
})
