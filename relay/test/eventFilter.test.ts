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

/**
 * Regression: message events. `message.updated` carries the session under
 * properties.sessionID AND properties.info.sessionID, while properties.info.id
 * is the MESSAGE id — reading that as a session id dropped every message
 * event, so viewers saw no live updates until they reloaded the page.
 */
test('keeps message.updated of the viewer session (info.id is a message id)', () => {
  const ev = JSON.stringify({
    type: 'message.updated',
    properties: {
      sessionID: 'ses_mine',
      info: { id: 'msg_1', role: 'user', sessionID: 'ses_mine' },
    },
  })
  expect(eventBelongsToSession(ev, 'ses_mine')).toBe(true)
})

test('drops message.updated of another session', () => {
  const ev = JSON.stringify({
    type: 'message.updated',
    properties: {
      sessionID: 'ses_other',
      info: { id: 'msg_1', role: 'user', sessionID: 'ses_other' },
    },
  })
  expect(eventBelongsToSession(ev, 'ses_mine')).toBe(false)
})

/**
 * Regression: message.part.updated nests the session under properties.part —
 * a fixed path list missed it, so another session's parts looked "global" and
 * were broadcast to the viewer.
 */
test('keeps message.part.updated nested under properties.part for this session', () => {
  const ev = JSON.stringify({
    type: 'message.part.updated',
    properties: { part: { id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_mine', type: 'text' } },
  })
  expect(eventBelongsToSession(ev, 'ses_mine')).toBe(true)
})

test('drops message.part.updated nested under properties.part for another session', () => {
  const ev = JSON.stringify({
    type: 'message.part.updated',
    properties: { part: { id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_other', type: 'text' } },
  })
  expect(eventBelongsToSession(ev, 'ses_mine')).toBe(false)
})

test('keeps permission events of this session and drops foreign ones', () => {
  const mine = JSON.stringify({
    type: 'permission.updated',
    properties: { id: 'per_1', sessionID: 'ses_mine', permission: 'bash' },
  })
  const other = JSON.stringify({
    type: 'permission.updated',
    properties: { id: 'per_1', sessionID: 'ses_other', permission: 'bash' },
  })
  expect(eventBelongsToSession(mine, 'ses_mine')).toBe(true)
  expect(eventBelongsToSession(other, 'ses_mine')).toBe(false)
})

test('session.updated still matches on info.id, and a non-session id is ignored', () => {
  const mine = JSON.stringify({ type: 'session.updated', properties: { info: { id: 'ses_mine' } } })
  const other = JSON.stringify({ type: 'session.updated', properties: { info: { id: 'ses_other' } } })
  expect(eventBelongsToSession(mine, 'ses_mine')).toBe(true)
  expect(eventBelongsToSession(other, 'ses_mine')).toBe(false)
})

test('keeps instance-wide events that mention no session', () => {
  for (const ev of [
    { type: 'plugin.added', properties: { id: 'some-plugin' } },
    { type: 'catalog.updated', properties: {} },
    { type: 'server.heartbeat', properties: {} },
  ]) {
    expect(eventBelongsToSession(JSON.stringify(ev), 'ses_mine')).toBe(true)
  }
})

test('drops an event that mentions this session AND another one', () => {
  const ev = JSON.stringify({
    type: 'message.part.updated',
    properties: { sessionID: 'ses_mine', part: { sessionID: 'ses_other' } },
  })
  expect(eventBelongsToSession(ev, 'ses_mine')).toBe(false)
})
