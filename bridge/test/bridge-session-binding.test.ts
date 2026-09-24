import { expect, test, vi } from 'vitest'
import { isProxyRequestAllowed, RelayWSClient } from '../src/relay'
import type { OpencodeClient } from '../src/opencode'

/**
 * The bridge's own binding of ':id' to the shared session.
 *
 * The relay force-binds every proxied ':id' to the viewer's session, but the
 * relay is a host the bridge merely dials — a compromised, swapped or
 * DNS-hijacked one could name any session it liked. The bridge has to bind the
 * id itself, because the bridge is the side where the request actually runs:
 * against every OTHER local session of the owner (and, through ?directory=,
 * every other project) a `shell` or a prompt is the same remote code execution
 * the allowlist exists to stop.
 */
const BOUND = 'ses_boundShareAAA'
const FOREIGN = 'ses_someOtherProjectBBB'

/** Writes and reads that belong to the bound session alone. */
const OUTSIDE_THE_SHARE: Array<[string, string]> = [
  ['POST', `/session/${FOREIGN}/shell?directory=%2Fp`],
  ['POST', `/session/${FOREIGN}/prompt_async?directory=%2Fp`],
  ['POST', `/session/${FOREIGN}/command?directory=%2Fp`],
  ['POST', `/session/${FOREIGN}/abort?directory=%2Fp`],
  ['POST', `/session/${FOREIGN}/revert?directory=%2Fp`],
  ['POST', `/session/${FOREIGN}/unrevert?directory=%2Fp`],
  ['POST', `/session/${FOREIGN}/summarize?directory=%2Fp`],
  ['GET', `/session/${FOREIGN}/children?directory=%2Fp`],
  // …and under the /api dialect, which the allowlist admits just the same.
  ['POST', `/api/session/${FOREIGN}/shell`],
  ['GET', `/api/session/${FOREIGN}/children`],
]

test.each(OUTSIDE_THE_SHARE)('refuses %s %s for another session', (method, path) => {
  expect(isProxyRequestAllowed(method, path, BOUND)).toBe(false)
  // The bound session's own spelling of the same route is the one that works.
  expect(isProxyRequestAllowed(method, path.replace(FOREIGN, BOUND), BOUND)).toBe(true)
})

test('with no bound session nothing session-scoped is allowed', () => {
  expect(isProxyRequestAllowed('GET', `/session/${BOUND}/message`)).toBe(false)
  expect(isProxyRequestAllowed('POST', `/session/${BOUND}/shell`)).toBe(false)
})

/**
 * A client with an open socket, a bound session and a session directory —
 * everything the guards read, without a relay.
 */
function client(opencode: Partial<OpencodeClient>, directory = '/proj') {
  const sent: Array<{ request_id: string; status: number; body: string }> = []
  const c = new RelayWSClient('http://relay.invalid', opencode as OpencodeClient)
  ;(c as unknown as { ws: unknown }).ws = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) }
  ;(c as unknown as { boundSessionId: string }).boundSessionId = BOUND
  ;(c as unknown as { sessionDirectory: string }).sessionDirectory = directory
  const deliver = (msg: unknown) =>
    (c as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(JSON.stringify(msg))
  return { sent, deliver }
}

/** opencode with one subagent of the share and one session that is not. */
function tree() {
  const calls: string[] = []
  const details: Record<string, unknown> = {
    ses_child1: { id: 'ses_child1', parentID: BOUND },
    ses_grand1: { id: 'ses_grand1', parentID: 'ses_child1' },
    [FOREIGN]: { id: FOREIGN },
  }
  return {
    calls,
    opencode: {
      request: async (method: string, path: string) => {
        calls.push(`${method} ${path}`)
        return { status: 200, contentType: 'application/json', body: '[]' }
      },
      getSession: async (id: string) => {
        const detail = details[id]
        if (!detail) throw new Error('getSession failed: 404')
        return detail
      },
    } as unknown as Partial<OpencodeClient>,
  }
}

test("another session's transcript is refused, its subagents' is not", async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const t = tree()
  const c = client(t.opencode)
  // The routes a subagent may appear on take any ses_… past the allowlist, so
  // this is where the descent has to be proven — and is not.
  await c.deliver({ type: 'proxy', request_id: 'r1', method: 'GET', path: `/session/${FOREIGN}/message?directory=%2Fp` })
  await c.deliver({ type: 'proxy', request_id: 'r2', method: 'POST', path: `/session/${FOREIGN}/message?directory=%2Fp` })
  await c.deliver({
    type: 'proxy',
    request_id: 'r3',
    method: 'POST',
    path: `/session/${FOREIGN}/permissions/per_1?directory=%2Fp`,
  })
  expect(t.calls).toEqual([])
  // 404, not 403: to this share there is no such session, and the relay's own
  // ancestry walk reads the difference (see guardSessionId).
  expect(c.sent.map((m) => [m.status, JSON.parse(m.body)])).toEqual([
    [404, { error: 'session not part of this share' }],
    [404, { error: 'session not part of this share' }],
    [404, { error: 'session not part of this share' }],
  ])

  // A real subagent, at any depth, still reads — that is what the subset is for.
  await c.deliver({ type: 'proxy', request_id: 'r4', method: 'GET', path: '/session/ses_child1/message?directory=%2Fp' })
  await c.deliver({ type: 'proxy', request_id: 'r5', method: 'GET', path: '/session/ses_grand1/todo?directory=%2Fp' })
  expect(t.calls).toEqual([
    'GET /session/ses_child1/message?directory=%2Fproj&location%5Bdirectory%5D=%2Fproj',
    'GET /session/ses_grand1/todo?directory=%2Fproj&location%5Bdirectory%5D=%2Fproj',
  ])
  expect(c.sent.slice(3).map((m) => m.status)).toEqual([200, 200])
  warn.mockRestore()
})

test('the session directory is pinned and the routing params are dropped', async () => {
  const t = tree()
  const c = client(t.opencode)
  await c.deliver({
    type: 'proxy',
    request_id: 'r1',
    method: 'GET',
    path: `/session/${BOUND}/message?directory=%2Fsomewhere%2Felse&workspace=other&scope=all&DIRECTORY=%2Fx&location%5Bworktree%5D=%2Fy&limit=50`,
  })
  const forwarded = t.calls[0]!
  expect(forwarded).toContain('directory=%2Fproj')
  expect(forwarded).toContain('limit=50')
  expect(forwarded).not.toContain('somewhere')
  expect(forwarded.toLowerCase()).not.toContain('workspace')
  expect(forwarded.toLowerCase()).not.toContain('scope')
  expect(forwarded.toLowerCase()).not.toContain('worktree')
})
