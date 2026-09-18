import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OpencodeClient } from '../src/opencode'
import { RelayWSClient } from '../src/relay'

/**
 * The permission guard must look for the request in the instance the answer
 * goes to.
 *
 * opencode holds pending permission requests per directory instance, and
 * GET /permission without ?directory=… lists the SERVER's own instance
 * (measured on opencode 1.18.30: the session's directory listed the pending
 * prompt, no directory returned []). The guard listed permissions without a
 * query, so whenever the shared session lived outside the server's directory —
 * the desktop app hosting several projects, or a server started from another
 * folder — it never found the request and refused every viewer answer with
 * 403. The session stayed blocked until the owner answered locally.
 *
 * The list is now read with the forwarded request's own ?directory=… (the one
 * the relay pins), so check and answer hit the same instance.
 */

const SES = 'ses_guardDir01'
const DIR = '/projects/shared-one'

let opencode: Server
let opencodeUrl: string
/** Query of every GET /permission the stand-in received. */
const listQueries: string[] = []
const answers: string[] = []

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.method === 'GET' && url.pathname === '/permission') {
      listQueries.push(url.search)
      const pending = url.searchParams.get('directory') === DIR ? [{ id: 'per_x', sessionID: SES }] : []
      return res.end(JSON.stringify(pending))
    }
    if (req.method === 'POST' && url.pathname === `/session/${SES}/permissions/per_x`) {
      answers.push(url.pathname + url.search)
      return res.end('true')
    }
    res.end('[]')
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`
})

afterAll(async () => {
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

test('a permission request in the session directory instance is answered', async () => {
  const client = new RelayWSClient('http://relay.invalid', new OpencodeClient(opencodeUrl, 'opencode', ''))
  const sent: Array<{ request_id: string; status: number; body: string }> = []
  // Stand in for an open socket bound to the shared session (see
  // bridge-allowlist.test.ts).
  ;(client as unknown as { ws: unknown }).ws = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) }
  ;(client as unknown as { boundSessionId: string }).boundSessionId = SES
  const path = `/session/${SES}/permissions/per_x?directory=${encodeURIComponent(DIR)}`
  await (client as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
    JSON.stringify({ type: 'proxy', request_id: 'r1', method: 'POST', path, body: { response: 'once' } }),
  )
  expect(sent.map((m) => [m.status, m.body])).toEqual([[200, 'true']])
  expect(answers).toEqual([path])
  expect(listQueries.map((q) => new URLSearchParams(q).get('directory'))).toEqual([DIR])
})
