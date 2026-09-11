import { afterEach, expect, test, vi } from 'vitest'
import { isProxyRequestAllowed, RelayWSClient } from '../src/relay'
import type { OpencodeClient } from '../src/opencode'

/**
 * Bridge-side allowlist. The relay's own allowlist protects the relay's users;
 * this one protects the machine running the bridge, which is the only place a
 * proxied path actually executes anything. It must therefore be a SUPERSET of
 * what the relay legitimately sends (otherwise working features 403 locally)
 * and a STRICT subset of "anything" (otherwise a compromised relay owns the
 * user's laptop).
 *
 * Every accepted shape below is written out as the relay builds it — including
 * the ?directory=… query the proxy adapter appends to every forwarded path and
 * the '/api/…' dialect the opencode web UI speaks.
 */

const SES = 'ses_3f8aBcD_01'

/** Exactly what relay ALLOWED_ROUTES + the relay's own handlers forward. */
const ACCEPTED: Array<[string, string]> = [
  // Session detail + messages (':id' force-bound to the viewer's session).
  ['GET', `/session/${SES}?directory=%2FUsers%2Fme%2Fproj`],
  ['GET', `/session/${SES}/message?directory=%2FUsers%2Fme%2Fproj&limit=50`],
  ['GET', `/session/${SES}/message/msg_7c1?directory=%2FUsers%2Fme%2Fproj`],
  ['POST', `/session/${SES}/message?directory=%2FUsers%2Fme%2Fproj`],
  ['POST', `/session/${SES}/prompt_async?directory=%2FUsers%2Fme%2Fproj`],
  ['POST', `/session/${SES}/abort?directory=%2FUsers%2Fme%2Fproj`],
  ['POST', `/session/${SES}/command?directory=%2FUsers%2Fme%2Fproj`],
  ['POST', `/session/${SES}/shell?directory=%2FUsers%2Fme%2Fproj`],
  ['POST', `/session/${SES}/summarize?directory=%2FUsers%2Fme%2Fproj`],
  ['POST', `/session/${SES}/revert?directory=%2FUsers%2Fme%2Fproj`],
  ['POST', `/session/${SES}/unrevert?directory=%2FUsers%2Fme%2Fproj`],
  ['POST', `/session/${SES}/fork?directory=%2FUsers%2Fme%2Fproj`],
  // The permission reply — the one POST that carries a second id segment.
  ['POST', `/session/${SES}/permissions/per_9ab?directory=%2FUsers%2Fme%2Fproj`],
  ['GET', `/session/${SES}/todo?directory=%2FUsers%2Fme%2Fproj`],
  ['GET', `/session/${SES}/children?directory=%2FUsers%2Fme%2Fproj`],
  ['GET', `/session/${SES}/diff?directory=%2FUsers%2Fme%2Fproj`],
  // Read-only global metadata the UI boots from.
  ['GET', '/agent?directory=%2Fp'],
  ['GET', '/command?directory=%2Fp'],
  ['GET', '/config?directory=%2Fp'],
  ['GET', '/config/providers?directory=%2Fp'],
  ['GET', '/provider?directory=%2Fp'],
  ['GET', '/provider/auth?directory=%2Fp'],
  ['GET', '/project/current?directory=%2Fp'],
  ['GET', '/path?directory=%2Fp'],
  ['GET', '/vcs?directory=%2Fp'],
  ['GET', '/mcp?directory=%2Fp'],
  ['GET', '/lsp?directory=%2Fp'],
  ['GET', '/formatter?directory=%2Fp'],
  ['GET', '/experimental/tool?directory=%2Fp'],
  ['GET', '/experimental/tool/ids?directory=%2Fp'],
  ['GET', '/file?directory=%2Fp&path=src'],
  ['GET', '/file/content?directory=%2Fp&path=src%2Fmain.ts'],
  ['GET', '/file/status?directory=%2Fp'],
  ['GET', '/find?directory=%2Fp&pattern=todo'],
  ['GET', '/find/file?directory=%2Fp&query=main'],
  ['GET', '/find/symbol?directory=%2Fp&query=start'],
  ['GET', '/global/health?directory=%2Fp'],
  ['GET', '/global/config?directory=%2Fp'],
  ['GET', '/question?directory=%2Fp'],
  ['POST', '/question?directory=%2Fp'],
  ['GET', '/experimental/resource?directory=%2Fp'],
  ['GET', '/experimental/capabilities?directory=%2Fp'],
  ['GET', '/experimental/workspace?directory=%2Fp'],
  ['GET', '/skill?directory=%2Fp'],
  ['GET', '/pty?directory=%2Fp'],
  ['GET', '/pty/shells?directory=%2Fp'],
  ['POST', '/log?directory=%2Fp'],
  // Routes the relay mounts only under the /api dialect.
  ['GET', '/api/reference?directory=%2Fp'],
  ['GET', '/api/agent?directory=%2Fp'],
  ['GET', '/api/command?directory=%2Fp'],
  ['GET', '/api/skill?directory=%2Fp'],
  // Paths the relay's own handlers build instead of templating.
  ['GET', '/project?directory=%2Fp'],
  ['GET', '/permission'],
  ['GET', '/session/status'],
  ['GET', `/session/${SES}`], // the subagent ancestry walk, no query
  // The '/api/…' twins of the above: the UI's bootstrap asks for these.
  ['GET', `/api/session/${SES}/message?directory=%2Fp`],
  ['GET', `/api/session/${SES}/message/msg_7c1`],
  ['POST', `/api/session/${SES}/prompt_async`],
  ['POST', `/api/session/${SES}/permissions/per_9ab`],
  ['GET', '/api/session/status'],
  ['GET', '/api/permission'],
  ['GET', '/api/project'],
  ['GET', '/api/project/current'],
  ['GET', '/api/config'],
  ['GET', '/api/global/health'],
]

test.each(ACCEPTED)('accepts %s %s', (method, path) => {
  expect(isProxyRequestAllowed(method, path)).toBe(true)
})

/**
 * Everything the relay never sends. `/event` is in here on purpose: the SSE
 * stream is NOT proxied — the bridge subscribes to opencode's /event itself
 * (startEventForwarding) and the relay fans that subscription out to viewers
 * from its own handlers, so no bridge.request() in relay/src/proxy/adapter.ts
 * ever names it. A `proxy` frame asking for it is therefore not the relay
 * doing its job.
 */
const REJECTED: Array<[string, string]> = [
  ['DELETE', `/session/${SES}`], // destroys the owner's session
  ['PATCH', '/config'], // rewrites the owner's opencode config
  ['PUT', `/session/${SES}/message`],
  ['GET', `/session/${SES}/../../etc`], // traversal out of the route
  ['GET', `/session/${SES}/%2e%2e/%2e%2e/etc`], // …percent-encoded (fetch re-normalises it)
  ['POST', '/experimental/worktree'], // enumerates the owner's other worktrees
  ['GET', '/event'], // never proxied — see above
  ['GET', '/global/event'],
  ['GET', '/api/event'],
  ['GET', `/session/ses_a%2F..%2Fses_b/message`], // encoded slash in the id segment
  ['GET', `/session/${SES}/message/msg%2F..%2Fsecret`], // …and in the messageID segment
  ['POST', `/session/${SES}/permissions/per%2Fx`],
  ['GET', `/session/${SES}/message/%ZZ`], // malformed escape: refuse, never guess
  ['GET', `/session/${SES}/message/msg_1%00`], // NUL in an id segment
  ['GET', `/session/${SES}/shell`], // right path, wrong verb (shell is POST-only)
  ['POST', `/session/${SES}/todo`], // right path, wrong verb (todo is GET-only)
  ['GET', '/auth/anthropic'], // not routed by the relay at all
  ['POST', '/session'], // session creation is not in the contract
  ['GET', '/session/not_a_session_id/message'], // ':id' must look like a session
  ['GET', 'http://evil.example/config'], // absolute URL, would re-target the host
  ['GET', '/session//message'], // empty id segment
]

test.each(REJECTED)('rejects %s %s', (method, path) => {
  expect(isProxyRequestAllowed(method, path)).toBe(false)
})

test('accepts the bridge’s own bound session id, whatever opencode called it', () => {
  // The relay force-binds ':id' to the session the bridge registered, so that
  // exact id is legitimate even when it does not match the ses_… convention.
  expect(isProxyRequestAllowed('GET', '/session/sess1/message', 'sess1')).toBe(true)
  expect(isProxyRequestAllowed('GET', '/session/sess1/message')).toBe(false)
  // …but the bound id is not a licence for another session's.
  expect(isProxyRequestAllowed('GET', '/session/sess2/message', 'sess1')).toBe(false)
})

test('a subagent session id is accepted on child-readable reads', () => {
  // The relay re-points ':id' at a descendant session for the child-readable
  // routes (see readableSessionId); those ids are real ses_… ids.
  expect(isProxyRequestAllowed('GET', '/session/ses_child1/message', SES)).toBe(true)
  expect(isProxyRequestAllowed('GET', '/session/ses_grand1/todo', SES)).toBe(true)
})

afterEach(() => {
  delete process.env.REMOTE_CONTROL_ALLOW_ANY_PATH
  vi.restoreAllMocks()
})

test('REMOTE_CONTROL_ALLOW_ANY_PATH=1 opens the gate, loudly', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(isProxyRequestAllowed('DELETE', '/session/anything/../../etc')).toBe(false)
  process.env.REMOTE_CONTROL_ALLOW_ANY_PATH = '1'
  expect(isProxyRequestAllowed('DELETE', '/session/anything/../../etc')).toBe(true)
  expect(isProxyRequestAllowed('PATCH', '/config')).toBe(true)
  expect(warn).toHaveBeenCalled()
  // Any other value keeps the gate shut.
  process.env.REMOTE_CONTROL_ALLOW_ANY_PATH = 'true'
  expect(isProxyRequestAllowed('PATCH', '/config')).toBe(false)
})

test('the socket handler answers a disallowed request with 403 and never calls opencode', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const calls: string[] = []
  const opencode = {
    request: async (method: string, path: string) => {
      calls.push(`${method} ${path}`)
      return { status: 200, contentType: 'application/json', body: '{}' }
    },
    listPermissions: async () => [],
  }
  const client = new RelayWSClient('http://relay.invalid', opencode as unknown as OpencodeClient)
  const sent: string[] = []
  // Stand in for an open socket: onMessage's replies go through send(), which
  // only writes when the socket is OPEN (1).
  ;(client as unknown as { ws: unknown }).ws = { readyState: 1, send: (raw: string) => sent.push(raw) }
  const deliver = (msg: unknown) =>
    (client as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(JSON.stringify(msg))

  await deliver({ type: 'proxy', request_id: 'r1', method: 'DELETE', path: `/session/${SES}` })
  expect(calls).toEqual([]) // opencode was never contacted
  const refusal = JSON.parse(sent[0]!) as { type: string; request_id: string; status: number; body: string }
  expect(refusal).toMatchObject({ type: 'proxy_response', request_id: 'r1', status: 403 })
  expect(JSON.parse(refusal.body)).toEqual({ error: 'path not allowed by bridge' })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(`DELETE /session/${SES}`))

  // An allowed request still goes through untouched, query and all.
  await deliver({ type: 'proxy', request_id: 'r2', method: 'GET', path: `/session/${SES}/message?directory=%2Fp` })
  expect(calls).toEqual([`GET /session/${SES}/message?directory=%2Fp`])
})
