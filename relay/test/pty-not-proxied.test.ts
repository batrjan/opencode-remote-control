import { expect, test } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * No /pty route is proxied, on either side.
 *
 * The allowlists used to carry `GET /pty` and `GET /pty/shells` and nothing
 * else of the family — not `POST /pty`, not `GET /pty/{id}/connect`, not
 * `POST /pty/{id}/connect-token`, not `PUT`/`DELETE /pty/{id}` — so the
 * viewer's terminal panel could list terminals and open none. The two entries
 * are gone, for a reason bigger than the dead end:
 *
 *   $ curl "$OPENCODE/pty?directory=$PROJECT"       # opencode 1.18.32
 *   [{"id":"pty_…","title":"owner-shell","command":"/bin/sh",
 *     "args":["-c","echo OWNER_SECRET_COMMAND; sleep 25","-l"],
 *     "cwd":"/home/owner/proj","status":"running","pid":2744915}]
 *
 * That is the owner's terminal command line, argument by argument — the same
 * disclosure the event filter drops `pty.created` for (GLOBAL_EVENT_KINDS in
 * the adapter), on a pull instead of a push. Keeping the route and calling the
 * panel "deliberately read-only" would have documented a viewer's right to
 * read the owner's command lines, which is neither what the README promises
 * nor what the `/project` and `/experimental/worktree` decisions assume.
 *
 * `GET /pty/shells` went with it: it exists to fill the picker of a "new
 * terminal" whose POST is unrouted, and on its own it is an inventory of the
 * owner's installed shells.
 *
 * Cost, measured: the shipped web UI requests neither route while booting or
 * during ordinary use — two Chromium probes of the real bundle against a shim
 * replicating this allowlist made 38 and 44 unique requests, with no /pty in
 * either. What a viewer loses is a panel that could not open a terminal.
 */

const ADAPTER = fileURLToPath(new URL('../src/proxy/adapter.ts', import.meta.url))
const BRIDGE_RELAY = fileURLToPath(new URL('../../bridge/src/relay.ts', import.meta.url))

/** The [method, path] pairs of one allowlist literal. */
function routes(source: string, name: string): string[] {
  const text = fs.readFileSync(source, 'utf8')
  const start = text.indexOf(name)
  expect(start, `${name} is gone from ${source}`).toBeGreaterThan(-1)
  const end = text.indexOf('\n]', start)
  expect(end, `${name} is no longer a literal array`).toBeGreaterThan(start)
  return [...text.slice(start, end).matchAll(/\[\s*'(GET|POST)'\s*,\s*'([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`)
}

test('the relay allowlist routes no /pty path', () => {
  const list = routes(ADAPTER, 'const ALLOWED_ROUTES')
  expect(list.length).toBeGreaterThan(20)
  expect(list.filter((r) => r.includes('/pty'))).toEqual([])
})

test("the bridge's own allowlist routes no /pty path either", () => {
  const list = routes(BRIDGE_RELAY, 'const RELAY_PROXY_ROUTES')
  expect(list.length).toBeGreaterThan(20)
  expect(list.filter((r) => r.includes('/pty'))).toEqual([])
})

/**
 * And the reason is written down where the next reader will look — the one
 * thing the old two entries lacked, which is what made them indistinguishable
 * from an oversight. The phrase is asserted verbatim so deleting the NOTE
 * fails here rather than quietly inviting the routes back.
 */
test('both allowlists say why the terminal routes are out', () => {
  for (const file of [ADAPTER, BRIDGE_RELAY]) {
    const text = fs.readFileSync(file, 'utf8')
    expect(text, `${file} drops /pty without saying why`).toContain('No /pty route is proxied')
  }
})
