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

/**
 * Subagents. The task tool runs in a child session, and the permission or
 * question it needs carries the CHILD's id. The web UI shows it in the parent's
 * dock only once the child's session.created has put it in the session tree, so
 * dropping every id but the shared one left the parent spinning with a prompt
 * no viewer could see. A descendant of the shared session is in scope; the
 * filter learns one from its own session.created / session.updated.
 */
function tree(): { has(id: string): boolean; add(id: string): void; ids: Set<string> } {
  const ids = new Set<string>()
  return { has: (id) => ids.has(id), add: (id) => void ids.add(id), ids }
}

const created = (id: string, parentID?: string, type = 'session.created') =>
  JSON.stringify({ type, properties: { info: { id, ...(parentID ? { parentID } : {}), title: 'x' } } })

test("a subagent's session.created passes and makes its prompts pass", () => {
  const known = tree()
  expect(eventBelongsToSession(created('ses_child', 'ses_mine'), 'ses_mine', known)).toBe(true)
  expect(known.ids).toEqual(new Set(['ses_child']))
  for (const ev of [
    { type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_child', permission: 'bash' } },
    { type: 'question.asked', properties: { id: 'que_1', sessionID: 'ses_child', questions: [] } },
    { type: 'session.status', properties: { sessionID: 'ses_child', status: { type: 'busy' } } },
    { type: 'message.part.updated', properties: { part: { id: 'prt_1', sessionID: 'ses_child' } } },
  ]) {
    expect(eventBelongsToSession(JSON.stringify(ev), 'ses_mine', known)).toBe(true)
  }
})

test('a nested subagent is learned through its parent, and from session.updated too', () => {
  const known = tree()
  expect(eventBelongsToSession(created('ses_child', 'ses_mine', 'session.updated'), 'ses_mine', known)).toBe(true)
  expect(eventBelongsToSession(created('ses_grand', 'ses_child'), 'ses_mine', known)).toBe(true)
  const asked = JSON.stringify({ type: 'permission.asked', properties: { id: 'per_2', sessionID: 'ses_grand' } })
  expect(eventBelongsToSession(asked, 'ses_mine', known)).toBe(true)
})

test('another session, its subagents and unknown sessions stay out', () => {
  const known = tree()
  known.add('ses_child')
  expect(eventBelongsToSession(created('ses_other'), 'ses_mine', known)).toBe(false)
  expect(eventBelongsToSession(created('ses_otherkid', 'ses_other'), 'ses_mine', known)).toBe(false)
  expect(known.ids).toEqual(new Set(['ses_child']))
  const foreign = JSON.stringify({ type: 'permission.asked', properties: { id: 'per_3', sessionID: 'ses_unknown' } })
  expect(eventBelongsToSession(foreign, 'ses_mine', known)).toBe(false)
  // A subagent does not vouch for another session named in the same event.
  const mixed = JSON.stringify({ type: 'message.part.updated', properties: { part: { sessionID: 'ses_child' }, x: { sessionID: 'ses_other' } } })
  expect(eventBelongsToSession(mixed, 'ses_mine', known)).toBe(false)
})

test('only session.created and session.updated can introduce a subagent', () => {
  const known = tree()
  const deleted = created('ses_child', 'ses_mine', 'session.deleted')
  eventBelongsToSession(deleted, 'ses_mine', known)
  // A non-session event with an info.parentID-looking shape teaches nothing.
  const message = JSON.stringify({
    type: 'message.updated',
    properties: { sessionID: 'ses_mine', info: { id: 'ses_child', parentID: 'ses_mine', sessionID: 'ses_mine' } },
  })
  expect(eventBelongsToSession(message, 'ses_mine', known)).toBe(true)
  expect(known.ids).toEqual(new Set())
})

test('without a subagent index the filter is as strict as before', () => {
  expect(eventBelongsToSession(created('ses_child', 'ses_mine'), 'ses_mine')).toBe(false)
})
