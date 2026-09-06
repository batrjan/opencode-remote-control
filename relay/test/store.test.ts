import { expect, test } from 'vitest'
import { Store } from '../src/store'

test('create session and activate code', () => {
  const store = new Store()
  const { access_code } = store.createSession('sess1', '/path', 'title', 'test-ip')
  expect(store.activate(access_code, 'sess1', 'client1')).toEqual({ session_id: 'sess1', viewer_token: expect.any(String) })
})

test('a valid code for one session does not activate another', () => {
  const store = new Store()
  const { access_code } = store.createSession('sessA', '/path', 'title', 'test-ip')
  store.createSession('sessB', '/path', 'title', 'test-ip')
  expect(() => store.activate(access_code, 'sessB', 'client_x')).toThrow('invalid code')
  expect(store.activate(access_code, 'sessA', 'client_x')).toEqual({ session_id: 'sessA', viewer_token: expect.any(String) })
})

test('activation normalizes input to uppercase', () => {
  const store = new Store()
  const { access_code } = store.createSession('sess3', '/path', 'title', 'test-ip')
  const lowercased = access_code.toLowerCase()
  expect(store.activate(lowercased, 'sess3', 'client_lc')).toEqual({ session_id: 'sess3', viewer_token: expect.any(String) })
})

test('rate limit per code blocks after threshold, using distinct IPs', () => {
  const store = new Store()
  const { access_code } = store.createSession('sess2', '/path', 'title', 'test-ip')
  for (let i = 0; i < 11; i++) {
    expect(() => store.activate('BAD', 'sess2', `client_${i}`)).toThrow()
  }
  expect(store.isCodeBlocked('sess2', access_code)).toBe(false)
  expect(store.isCodeBlocked('sess2', 'BAD')).toBe(true)
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
      expect(() => store.activate('AAAAAA', sess, `ip_${sess}_${i}`)).toThrow('invalid code')
    }
  }
  expect(store.isCodeBlocked('sessA', 'AAAAAA')).toBe(true)
  expect(store.isCodeBlocked('sessB', 'AAAAAA')).toBe(true)
  for (let i = 0; i < 10; i++) {
    expect(() => store.activate('CCCCCC', 'sessC', `ip_c_${i}`)).toThrow('invalid code')
  }
  expect(store.isCodeBlocked('sessC', 'CCCCCC')).toBe(true)
  expect(store.isCodeBlocked('sessA', 'AAAAAA')).toBe(false) // evicted (oldest)
})

test('codeFails evicts the oldest counter when the cap is reached', () => {
  const store = new Store(2)
  // 5 fails each on A and B (below the block threshold of 10).
  for (let i = 0; i < 5; i++) expect(() => store.activate('AAAAAA', 'sessA', `ip_a_${i}`)).toThrow()
  for (let i = 0; i < 5; i++) expect(() => store.activate('BBBBBB', 'sessB', `ip_b_${i}`)).toThrow()
  // First fail on C evicts A's counter; 5 more fails on A restart it at 1..5.
  for (let i = 0; i < 6; i++) expect(() => store.activate('CCCCCC', 'sessC', `ip_c_${i}`)).toThrow()
  for (let i = 0; i < 5; i++) expect(() => store.activate('AAAAAA', 'sessA', `ip_a2_${i}`)).toThrow()
  // Had A's counter survived, A would now be at 10 fails and blocked.
  expect(store.isCodeBlocked('sessA', 'AAAAAA')).toBe(false)
})

test('ipAttempts evicts the oldest record when the cap is reached', () => {
  const store = new Store(2)
  // ip1 exhausts its per-minute allowance.
  for (let i = 0; i < 5; i++) expect(() => store.activate('ZZZZZZ', 'sessX', 'ip1')).toThrow('invalid code')
  expect(() => store.activate('ZZZZZZ', 'sessX', 'ip1')).toThrow('rate limited')
  // Two more IPs push ip1's record out of the bounded map.
  expect(() => store.activate('ZZZZZZ', 'sessX', 'ip2')).toThrow('invalid code')
  expect(() => store.activate('ZZZZZZ', 'sessX', 'ip3')).toThrow('invalid code')
  // ip1's window is gone, so it is allowed again (and fails the code check).
  expect(() => store.activate('ZZZZZZ', 'sessX', 'ip1')).toThrow('invalid code')
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
  expect(() => store.activate(access_code, 'sessB', 'ip_legit')).toThrow('rate limited')
})
