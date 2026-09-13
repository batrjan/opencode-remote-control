import { expect, test } from 'vitest'
import { RelayWSClient } from '../src/relay'
import type { OpencodeClient } from '../src/opencode'

/**
 * The ownership guards must accept prompts raised by the shared session's
 * SUBAGENTS.
 *
 * When the agent runs the task tool, opencode starts a child session whose
 * parentID is the shared one, and a permission or question the subagent needs
 * carries the child's session id (measured on opencode 1.18.30). The guards
 * accepted only requests whose sessionID was the bound session itself, so a
 * viewer's answer to a subagent prompt got 403 "permission request not found
 * for this session" and the whole share stayed blocked until the owner
 * answered locally.
 *
 * A request now passes when its session is the bound one or descends from it,
 * proven by walking parentID through the local opencode in the forwarded
 * request's own instance. Anything else — another session, its subagents, a
 * chain that cannot be read, loops or runs too deep — is still refused.
 */

const SES = 'ses_guardParent01'
const QUERY = '?directory=%2Fwork%2Fproj'

type Info = { id: string; parentID?: string }

function guardClient(sessions: Record<string, Info | Error>) {
  const calls: string[] = []
  const lookups: string[] = []
  const pending = [
    { id: 'per_mine', sessionID: SES },
    { id: 'per_child', sessionID: 'ses_child' },
    { id: 'per_grand', sessionID: 'ses_grand' },
    { id: 'per_other', sessionID: 'ses_other' },
    { id: 'per_otherkid', sessionID: 'ses_otherkid' },
    { id: 'per_broken', sessionID: 'ses_broken' },
    { id: 'per_loop', sessionID: 'ses_loopA' },
    { id: 'per_liar', sessionID: 'ses_liar' },
    { id: 'per_deep', sessionID: 'ses_deep0' },
  ]
  const opencode = {
    request: async (method: string, path: string) => {
      calls.push(`${method} ${path}`)
      return { status: 200, contentType: 'application/json', body: 'true' }
    },
    listPermissions: async () => pending,
    listQuestions: async () => pending.map((p) => ({ ...p, id: p.id.replace('per_', 'que_') })),
    getSession: async (id: string, query: string) => {
      lookups.push(`${id}${query}`)
      const found = sessions[id]
      if (found instanceof Error) throw found
      if (!found) throw new Error('getSession failed: 404')
      return found
    },
  }
  const client = new RelayWSClient('http://relay.invalid', opencode as unknown as OpencodeClient)
  const sent: Array<{ request_id: string; status: number; body: string }> = []
  ;(client as unknown as { ws: unknown }).ws = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) }
  ;(client as unknown as { boundSessionId: string }).boundSessionId = SES
  const post = (path: string) =>
    (client as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
      JSON.stringify({ type: 'proxy', request_id: path, method: 'POST', path: path + QUERY, body: { response: 'once' } }),
    )
  return { calls, lookups, sent, post }
}

const deep: Record<string, Info> = {}
for (let i = 0; i < 20; i++) deep[`ses_deep${i}`] = { id: `ses_deep${i}`, parentID: i === 19 ? SES : `ses_deep${i + 1}` }

const SESSIONS: Record<string, Info | Error> = {
  ses_child: { id: 'ses_child', parentID: SES },
  ses_grand: { id: 'ses_grand', parentID: 'ses_child' },
  ses_other: { id: 'ses_other' },
  ses_otherkid: { id: 'ses_otherkid', parentID: 'ses_other' },
  ses_broken: new Error('opencode unreachable'),
  ses_loopA: { id: 'ses_loopA', parentID: 'ses_loopB' },
  ses_loopB: { id: 'ses_loopB', parentID: 'ses_loopA' },
  // Answers for another id: not proof of anything.
  ses_liar: { id: 'ses_child', parentID: SES },
  ...deep,
}

test("a subagent's and a nested subagent's permission prompts are answered", async () => {
  const g = guardClient(SESSIONS)
  await g.post('/session/ses_child/permissions/per_child')
  await g.post('/api/session/ses_grand/permissions/per_grand')
  expect(g.sent.map((m) => m.status)).toEqual([200, 200])
  expect(g.calls).toEqual([
    `POST /session/ses_child/permissions/per_child${QUERY}`,
    `POST /api/session/ses_grand/permissions/per_grand${QUERY}`,
  ])
  // The chain is read in the instance the answer goes to.
  expect(g.lookups).toEqual([`ses_child${QUERY}`, `ses_grand${QUERY}`, `ses_child${QUERY}`])
})

test('the bound session itself needs no walk', async () => {
  const g = guardClient(SESSIONS)
  await g.post(`/session/${SES}/permissions/per_mine`)
  expect(g.sent.map((m) => m.status)).toEqual([200])
  expect(g.lookups).toEqual([])
})

test('prompts of other sessions and of chains that prove nothing are refused', async () => {
  const g = guardClient(SESSIONS)
  for (const id of ['per_other', 'per_otherkid', 'per_broken', 'per_loop', 'per_liar', 'per_deep']) {
    await g.post(`/session/ses_child/permissions/${id}`)
  }
  expect(g.calls).toEqual([])
  expect(g.sent.map((m) => [m.status, JSON.parse(m.body).error])).toEqual(
    Array(6).fill([403, 'permission request not found for this session']),
  )
})

/**
 * The allowlist admits the '/api' twin of the permission answer, but the guard
 * matched only the bare spelling, so that twin skipped the ownership check and
 * a relay could answer any session's prompt through it.
 */
test("the /api spelling of the permission answer is checked like the bare one", async () => {
  const g = guardClient(SESSIONS)
  await g.post(`/api/session/${SES}/permissions/per_other`)
  await g.post('/api/session/ses_child/permissions/per_otherkid')
  expect(g.calls).toEqual([])
  expect(g.sent.map((m) => m.status)).toEqual([403, 403])
})

test("a subagent's question is answered and dismissed; another session's is not", async () => {
  const g = guardClient(SESSIONS)
  await g.post('/question/que_child/reply')
  await g.post('/question/que_grand/reject')
  await g.post('/question/que_otherkid/reply')
  await g.post('/question/que_broken/reply')
  expect(g.sent.map((m) => m.status)).toEqual([200, 200, 403, 403])
  expect(g.calls).toEqual([`POST /question/que_child/reply${QUERY}`, `POST /question/que_grand/reject${QUERY}`])
})
