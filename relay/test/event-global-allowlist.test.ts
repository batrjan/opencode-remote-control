import { beforeEach, expect, test } from 'vitest'
import { eventBelongsToSession } from '../src/proxy/adapter'
import { droppedGlobalEvents, resetDroppedGlobalEvents } from '../src/proxy/event-drops'
import { KEPT_GLOBAL_EVENTS, LEAKY_GLOBAL_EVENTS, PTY_CREATED, SERVER_CONNECTED } from './helpers/opencode-events-1.18.32'

/**
 * The event filter's default for an UNSESSIONED event.
 *
 * opencode's /event stream is scoped to the shared project directory and to
 * nothing narrower: about a third of the 89 event kinds 1.18.32 emits carry no
 * session id at all, and the filter used to read "no session id → global →
 * forward". That handed a viewer of one share the owner's parallel work in the
 * same directory: the command line and cwd of every terminal the owner opened,
 * the text they typed into their own TUI, their toasts, the paths the edit tool
 * touched, the project record `GET /project` is deliberately filtered to hide
 * (see the NOTE at adapter.ts:66).
 *
 * The default is now the other way round: an unsessioned event is forwarded
 * only if its kind is on the allow-list, and everything else is dropped and
 * counted. Payloads below are captured from a live 1.18.32 stream — see
 * helpers/opencode-events-1.18.32.ts.
 */

beforeEach(() => resetDroppedGlobalEvents())

test.each(LEAKY_GLOBAL_EVENTS)('drops the unsessioned %s', (_name, payload) => {
  expect(eventBelongsToSession(payload, 'ses_mine')).toBe(false)
})

test.each(KEPT_GLOBAL_EVENTS)('keeps the unsessioned %s', (_name, payload) => {
  expect(eventBelongsToSession(payload, 'ses_mine')).toBe(true)
})

test('the owner terminal command line never reaches a viewer', () => {
  expect(PTY_CREATED).toContain('OWNER_SECRET_COMMAND')
  expect(eventBelongsToSession(PTY_CREATED, 'ses_mine')).toBe(false)
})

test('an unknown future kind with no session id is dropped, not forwarded', () => {
  const ev = JSON.stringify({ type: 'something.new.upstream.added', properties: { path: '/home/owner/secret' } })
  expect(eventBelongsToSession(ev, 'ses_mine')).toBe(false)
})

test('an event with no type at all is dropped', () => {
  expect(eventBelongsToSession(JSON.stringify({ properties: { x: 1 } }), 'ses_mine')).toBe(false)
  expect(eventBelongsToSession(JSON.stringify({ type: 42, properties: {} }), 'ses_mine')).toBe(false)
})

/** Session-scoped events are untouched by the allow-list. */
test('the allow-list does not change how session events are filtered', () => {
  const mine = JSON.stringify({ type: 'message.part.updated', properties: { part: { sessionID: 'ses_mine' } } })
  const other = JSON.stringify({ type: 'message.part.updated', properties: { part: { sessionID: 'ses_other' } } })
  expect(eventBelongsToSession(mine, 'ses_mine')).toBe(true)
  expect(eventBelongsToSession(other, 'ses_mine')).toBe(false)
  // A session.error that names the share still passes; the unsessioned one above does not.
  const scoped = JSON.stringify({ type: 'session.error', properties: { sessionID: 'ses_mine', error: { name: 'UnknownError' } } })
  expect(eventBelongsToSession(scoped, 'ses_mine')).toBe(true)
})

/**
 * Dropping silently is the failure this fix must not introduce: a kind the
 * viewer's UI turns out to need looks like a panel that never updates, with
 * nothing in any log to point at. So every drop is counted by kind, and the
 * count is on /health's operator side.
 */
test('a dropped kind is counted, by kind', () => {
  expect(droppedGlobalEvents()).toEqual({})
  eventBelongsToSession(PTY_CREATED, 'ses_mine')
  eventBelongsToSession(PTY_CREATED, 'ses_mine')
  eventBelongsToSession(LEAKY_GLOBAL_EVENTS[1][1], 'ses_mine')
  expect(droppedGlobalEvents()).toEqual({ 'pty.created': 2, 'tui.prompt.append': 1 })
})

test('a forwarded kind is not counted', () => {
  eventBelongsToSession(SERVER_CONNECTED, 'ses_mine')
  expect(droppedGlobalEvents()).toEqual({})
})

/**
 * The counter is fed by the owner's own opencode, so it is bounded: a stream
 * inventing a new kind per event must not grow the map without end.
 */
test('the drop counter is bounded in the number of kinds it tracks', () => {
  for (let i = 0; i < 500; i++) {
    eventBelongsToSession(JSON.stringify({ type: `made.up.${i}`, properties: {} }), 'ses_mine')
  }
  expect(Object.keys(droppedGlobalEvents()).length).toBeLessThanOrEqual(64)
})
