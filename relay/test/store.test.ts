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
