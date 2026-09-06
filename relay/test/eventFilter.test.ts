import { expect, test } from 'vitest'
import { eventBelongsToSession } from '../src/proxy/adapter'

test('drops events carrying a different sessionID', () => {
  const ev = JSON.stringify({ type: 'message.part.updated', properties: { sessionID: 'ses_other' } })
  expect(eventBelongsToSession(ev, 'ses_mine')).toBe(false)
})

test('keeps events carrying the viewer sessionID', () => {
  const ev = JSON.stringify({ type: 'message.part.updated', properties: { sessionID: 'ses_mine' } })
  expect(eventBelongsToSession(ev, 'ses_mine')).toBe(true)
})

test('keeps global events with no session reference', () => {
  expect(eventBelongsToSession(JSON.stringify({ type: 'server.connected', properties: {} }), 'ses_mine')).toBe(true)
  expect(eventBelongsToSession(JSON.stringify({ type: 'server.heartbeat' }), 'ses_mine')).toBe(true)
})

test('keeps events whose nested info.id matches the session', () => {
  const ev = JSON.stringify({ type: 'session.updated', properties: { info: { id: 'ses_mine' } } })
  expect(eventBelongsToSession(ev, 'ses_mine')).toBe(true)
  const other = JSON.stringify({ type: 'session.updated', properties: { info: { id: 'ses_other' } } })
  expect(eventBelongsToSession(other, 'ses_mine')).toBe(false)
})

test('fails closed on unparseable payloads', () => {
  expect(eventBelongsToSession('not json', 'ses_mine')).toBe(false)
  expect(eventBelongsToSession('{bad', 'ses_mine')).toBe(false)
})
