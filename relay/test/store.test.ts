import { expect, test } from 'vitest'
import { Store } from '../src/store'

test('create session and activate code', () => {
  const store = new Store()
  const { access_code } = store.createSession('sess1', '/path', 'title')
  expect(store.activate(access_code, 'client1')).toEqual({ session_id: 'sess1', viewer_token: expect.any(String) })
})

test('rate limit per code', () => {
  const store = new Store()
  const { access_code } = store.createSession('sess2', '/path', 'title')
  for (let i = 0; i < 10; i++) {
    expect(() => store.activate('bad', 'client2')).toThrow()
  }
  expect(store.isCodeBlocked(access_code)).toBe(false)
})
