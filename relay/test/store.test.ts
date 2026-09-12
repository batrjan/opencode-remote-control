import { expect, test } from 'vitest'
import { Store } from '../src/store'
import { config } from '../src/config'

test('create session and activate code', () => {
  const store = new Store()
  const { access_code } = store.createSession('sess1', '/path', 'title', 'test-ip')
  expect(store.activate(access_code, 'sess1')).toEqual({ session_id: 'sess1', viewer_token: expect.any(String) })
})

test('a valid code for one session does not activate another', () => {
  const store = new Store()
  const { access_code } = store.createSession('sessA', '/path', 'title', 'test-ip')
  store.createSession('sessB', '/path', 'title', 'test-ip')
  expect(() => store.activate(access_code, 'sessB')).toThrow('invalid code')
  expect(store.activate(access_code, 'sessA')).toEqual({ session_id: 'sessA', viewer_token: expect.any(String) })
})

test('activation normalizes input to uppercase', () => {
  const store = new Store()
  const { access_code } = store.createSession('sess3', '/path', 'title', 'test-ip')
  const lowercased = access_code.toLowerCase()
  expect(store.activate(lowercased, 'sess3')).toEqual({ session_id: 'sess3', viewer_token: expect.any(String) })
})

test('one specific wrong code is blocked after a few repeats', () => {
  const store = new Store()
  const { access_code } = store.createSession('sess2', '/path', 'title', 'test-ip')
  // Deliberately fewer than sessionFailLockThreshold: the per-code block has to
  // be reachable BEFORE the session lock swallows everything, or it is not a
  // mechanism at all.
  expect(config.codeFailBlockThreshold).toBeLessThan(config.sessionFailLockThreshold)
  for (let i = 0; i < config.codeFailBlockThreshold; i++) {
    expect(() => store.activate('BAD', 'sess2')).toThrow('invalid code')
  }
  expect(store.isCodeBlocked('sess2', 'BAD')).toBe(true)
  // Only that guess: the real code is untouched, and still works.
  expect(store.isCodeBlocked('sess2', access_code)).toBe(false)
  expect(store.activate(access_code, 'sess2').viewer_token).toBeTruthy()
})

test('createSession rejects a duplicate session id', () => {
  const store = new Store()
  store.createSession('sess1', '/path', 'title', 'test-ip')
  expect(() => store.createSession('sess1', '/other', 'takeover', 'test-ip')).toThrow('session exists')
  expect(store.getSession('sess1')?.directory).toBe('/path')
})

test('deleteSession reports whether the session existed', () => {
  const store = new Store()
  store.createSession('sess1', '/path', 'title', 'test-ip')
  expect(store.deleteSession('sess1')).toBe(true)
  expect(store.deleteSession('sess1')).toBe(false)
})

/**
 * Memory-safety caps: codeFails / blockedCodes / ipAttempts must not grow
 * without bound. A small cap (constructor arg) keeps the eviction tests fast;
 * production uses config.maxTrackingEntries (100k). Eviction is FIFO
 * (insertion order) — acceptable because per-IP limits bound refill speed.
 * Attempt keys are session-scoped ('sessX:CODE'), so each loop below uses a
 * distinct session id to keep keys distinct under the new binding.
 */
test('blockedCodes evicts the oldest entry when the cap is reached', () => {
  const store = new Store(2)
  for (const sess of ['sessA', 'sessB']) {
    for (let i = 0; i < 10; i++) {
      expect(() => store.activate('AAAAAA', sess)).toThrow('invalid code')
    }
  }
  expect(store.isCodeBlocked('sessA', 'AAAAAA')).toBe(true)
  expect(store.isCodeBlocked('sessB', 'AAAAAA')).toBe(true)
  for (let i = 0; i < 10; i++) {
    expect(() => store.activate('CCCCCC', 'sessC')).toThrow('invalid code')
  }
  expect(store.isCodeBlocked('sessC', 'CCCCCC')).toBe(true)
  expect(store.isCodeBlocked('sessA', 'AAAAAA')).toBe(false) // evicted (oldest)
})

test('codeFails evicts the oldest counter when the cap is reached', () => {
  const store = new Store(2)
  // Two fails each on A and B — one short of the block threshold, and well
  // short of the per-session lock, so neither fires and the counters just sit
  // there filling the two-entry map.
  const below = config.codeFailBlockThreshold - 1
  for (let i = 0; i < below; i++) expect(() => store.activate('AAAAAA', 'sessA')).toThrow()
  for (let i = 0; i < below; i++) expect(() => store.activate('BBBBBB', 'sessB')).toThrow()
  // A fail on C evicts A's counter (insertion order, oldest first)...
  expect(() => store.activate('CCCCCC', 'sessC')).toThrow()
  // ...so A starts from zero again and stays under the threshold.
  for (let i = 0; i < below; i++) expect(() => store.activate('AAAAAA', 'sessA')).toThrow()
  // Had A's counter survived, A would be at 2 x below >= the threshold by now.
  expect(store.isCodeBlocked('sessA', 'AAAAAA')).toBe(false)
})

test('sessionFails evicts the oldest record when the cap is reached', () => {
  // The lockout counters live in a bounded map so a flood of attempts against
  // invented session ids cannot grow memory without limit. Eviction costs a
  // lockout, never a stored secret — the trade this cap deliberately makes.
  const store = new Store(2)
  const lockOut = (id: string) => {
    for (let i = 0; i < config.sessionFailLockThreshold; i++) {
      expect(() => store.activate(`NO${i}`, id)).toThrow('invalid code')
    }
    expect(() => store.activate('ANY', id)).toThrow('rate limited')
  }
  lockOut('sessA')
  // Two more sessions push sessA's record out of the two-entry map...
  lockOut('sessB')
  lockOut('sessC')
  // ...so sessA is no longer locked and its attempts are evaluated again.
  expect(() => store.activate('ZZZZZZ', 'sessA')).toThrow('invalid code')
})

test('per-session brute-force lockout: many failed codes against one session lock it temporarily', () => {
  const store = new Store()
  const { access_code } = store.createSession('sessB', '/path', 'title', 'test-ip')
  // Failed attempts against sessB until the per-session counter reaches the
  // lock threshold (one attempt below may not register depending on ordering).
  for (let i = 0; i < 21; i++) {
    expect(() => store.activate(`WRONG${i}`.slice(0, 6).padEnd(6, 'X'), 'sessB', `ip_bf_${i}`)).toThrow()
  }
  // The 21st attempt — even with the CORRECT code — is rate limited.
  expect(() => store.activate(access_code, 'sessB')).toThrow('rate limited')
})

test('reapOrphans deletes idle sessions and keeps active ones', () => {
  const store = new Store()
  store.createSession('sess_old', '/path', 'title', 'ip1')
  store.createSession('sess_new', '/path', 'title', 'ip2')
  // Age the old session manually.
  const old = store.getSession('sess_old')!
  old.last_seen = Date.now() - 25 * 3_600_000 // 25h ago
  const removed = store.reapOrphans(24 * 3_600_000)
  expect(removed).toEqual(['sess_old'])
  expect(store.getSession('sess_old')).toBeUndefined()
  expect(store.getSession('sess_new')).toBeTruthy()
})

test('touchSession refreshes last_seen', () => {
  const store = new Store()
  store.createSession('sess_t', '/path', 'title', 'ip1')
  const s = store.getSession('sess_t')!
  s.last_seen = Date.now() - 100_000
  const before = s.last_seen
  store.touchSession('sess_t')
  expect(store.getSession('sess_t')!.last_seen).toBeGreaterThan(before)
})
