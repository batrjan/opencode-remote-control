import { expect, test } from 'vitest'
import { Store } from '../src/store'

test('create session and activate code', () => {
  const store = new Store()
  const { access_code } = store.createSession('sess1', '/path', 'title')
  expect(store.activate(access_code, 'client1')).toEqual({ session_id: 'sess1', viewer_token: expect.any(String) })
})

test('activation normalizes input to uppercase', () => {
  const store = new Store()
  const { access_code } = store.createSession('sess3', '/path', 'title')
  const lowercased = access_code.toLowerCase()
  expect(store.activate(lowercased, 'client_lc')).toEqual({ session_id: 'sess3', viewer_token: expect.any(String) })
})

test('rate limit per code blocks after threshold, using distinct IPs', () => {
  const store = new Store()
  const { access_code } = store.createSession('sess2', '/path', 'title')
  for (let i = 0; i < 11; i++) {
    expect(() => store.activate('bad', `client_${i}`)).toThrow()
  }
  expect(store.isCodeBlocked(access_code)).toBe(false)
  expect(store.isCodeBlocked('badcode')).toBe(false)
})

test('createSession rejects a duplicate session id', () => {
  const store = new Store()
  store.createSession('sess1', '/path', 'title')
  expect(() => store.createSession('sess1', '/other', 'takeover')).toThrow('session exists')
  expect(store.getSession('sess1')?.directory).toBe('/path')
})

test('deleteSession reports whether the session existed', () => {
  const store = new Store()
  store.createSession('sess1', '/path', 'title')
  expect(store.deleteSession('sess1')).toBe(true)
  expect(store.deleteSession('sess1')).toBe(false)
})

/**
 * Memory-safety caps: codeFails / blockedCodes / ipAttempts must not grow
 * without bound. A small cap (constructor arg) keeps the eviction tests fast;
 * production uses config.maxTrackingEntries (100k). Eviction is FIFO
 * (insertion order) — acceptable because per-IP limits bound refill speed.
 */
test('blockedCodes evicts the oldest entry when the cap is reached', () => {
  const store = new Store(2)
  for (const code of ['AAAAAA', 'BBBBBB']) {
    for (let i = 0; i < 10; i++) {
      expect(() => store.activate(code, `ip_${code}_${i}`)).toThrow('invalid code')
    }
  }
  expect(store.isCodeBlocked('AAAAAA')).toBe(true)
  expect(store.isCodeBlocked('BBBBBB')).toBe(true)
  for (let i = 0; i < 10; i++) {
    expect(() => store.activate('CCCCCC', `ip_c_${i}`)).toThrow('invalid code')
  }
  expect(store.isCodeBlocked('CCCCCC')).toBe(true)
  expect(store.isCodeBlocked('AAAAAA')).toBe(false) // evicted (oldest)
})

test('codeFails evicts the oldest counter when the cap is reached', () => {
  const store = new Store(2)
  // 5 fails each on A and B (below the block threshold of 10).
  for (let i = 0; i < 5; i++) expect(() => store.activate('AAAAAA', `ip_a_${i}`)).toThrow()
  for (let i = 0; i < 5; i++) expect(() => store.activate('BBBBBB', `ip_b_${i}`)).toThrow()
  // First fail on C evicts A's counter; 5 more fails on A restart it at 1..5.
  for (let i = 0; i < 6; i++) expect(() => store.activate('CCCCCC', `ip_c_${i}`)).toThrow()
  for (let i = 0; i < 5; i++) expect(() => store.activate('AAAAAA', `ip_a2_${i}`)).toThrow()
  // Had A's counter survived, A would now be at 10 fails and blocked.
  expect(store.isCodeBlocked('AAAAAA')).toBe(false)
})

test('ipAttempts evicts the oldest record when the cap is reached', () => {
  const store = new Store(2)
  // ip1 exhausts its per-minute allowance.
  for (let i = 0; i < 5; i++) expect(() => store.activate('ZZZZZZ', 'ip1')).toThrow('invalid code')
  expect(() => store.activate('ZZZZZZ', 'ip1')).toThrow('rate limited')
  // Two more IPs push ip1's record out of the bounded map.
  expect(() => store.activate('ZZZZZZ', 'ip2')).toThrow('invalid code')
  expect(() => store.activate('ZZZZZZ', 'ip3')).toThrow('invalid code')
  // ip1's window is gone, so it is allowed again (and fails the code check).
  expect(() => store.activate('ZZZZZZ', 'ip1')).toThrow('invalid code')
})
