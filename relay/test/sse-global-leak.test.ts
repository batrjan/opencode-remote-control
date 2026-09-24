import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { viewerTokenFrom } from './helpers/viewer-token'
import { startServer } from '../src/server'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'
import {
  FILE_WATCHER_UPDATED,
  LEAKY_GLOBAL_EVENTS,
  PTY_CREATED,
  SERVER_HEARTBEAT,
  TUI_PROMPT_APPEND,
  VCS_BRANCH_UPDATED,
} from './helpers/opencode-events-1.18.32'

/**
 * End to end: does the owner's parallel work reach a viewer's stream?
 *
 * mock opencode /event (real 1.18.32 payloads) → the real bridge WS client →
 * the real relay → one viewer's SSE stream. What the viewer's browser would
 * have received is exactly what this test reads off the socket.
 *
 * Before the allow-list, `pty.created` arrived with the owner's command line
 * on it. The stream is scoped to the shared project DIRECTORY upstream, never
 * to the session, so everything the owner did in that directory — terminals,
 * TUI typing, edits, the project record — was "global" to the filter and went
 * out to every viewer of every share on it.
 */

let relay: Server
let relayUrl: string
let opencode: Server
let bridge: RelayWSClient
let viewerToken: string

const API_KEY = 'test-relay-key-leak'
process.env.RELAY_API_KEY = API_KEY

const SESSION = 'ses_leak1'
/** Pushed to every /event subscriber; the mock replays them on connect. */
const SCRIPT: string[] = [
  ...LEAKY_GLOBAL_EVENTS.map(([, payload]) => payload),
  VCS_BRANCH_UPDATED,
  FILE_WATCHER_UPDATED,
  SERVER_HEARTBEAT,
  // One session-scoped event, so "nothing arrives" cannot pass this test.
  JSON.stringify({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'busy' } } }),
]

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      let i = 0
      const timer = setInterval(() => {
        res.write(`data: ${SCRIPT[i % SCRIPT.length]}\n\n`)
        i++
      }, 20)
      req.on('close', () => clearInterval(timer))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  const opencodePort = (opencode.address() as AddressInfo).port

  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`

  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id: SESSION, directory: '/home/owner/proj', title: 'title' })
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id: SESSION })
  viewerToken = viewerTokenFrom(activated)

  bridge = new RelayWSClient(relayUrl, new OpencodeClient(`http://127.0.0.1:${opencodePort}`, 'opencode', 'password'))
  await bridge.connect(SESSION, created.body.bridge_token)
  await bridge.startEventForwarding()
})

afterAll(async () => {
  bridge.close()
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

/**
 * Read one viewer's stream over a WHOLE pass of the script.
 *
 * The mock pushes SCRIPT in a loop to the bridge's single subscription, so a
 * viewer opening mid-cycle would otherwise see an arbitrary slice of it — and
 * a leak test that reads a slice passes by luck. The session event is the
 * sentinel: seeing it twice means every kind in between went past this viewer.
 */
const SENTINEL = '"session.status"'
async function fullCycle(path: string, ms = 8000): Promise<string> {
  const res = await fetch(`${relayUrl}${path}`, { headers: { 'x-viewer-token': viewerToken } })
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  const seen = () => received.split(SENTINEL).length - 1
  const deadline = Date.now() + ms
  while (seen() < 2 && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    received += decoder.decode(value, { stream: true })
  }
  await reader.cancel().catch(() => {})
  expect(seen(), 'the viewer stream did not carry a full pass of the script').toBeGreaterThanOrEqual(2)
  return received
}

test("a viewer's stream never carries the owner's terminal command line", async () => {
  const seen = await fullCycle('/event')
  // The session event proves the stream is live and the filter is not simply
  // dropping everything.
  expect(seen).toContain('"session.status"')
  expect(PTY_CREATED).toContain('OWNER_SECRET_COMMAND')
  expect(seen).not.toContain('OWNER_SECRET_COMMAND')
  expect(seen).not.toContain('"pty.created"')
})

test("a viewer's stream never carries what the owner types in their own TUI", async () => {
  const seen = await fullCycle('/event')
  expect(TUI_PROMPT_APPEND).toContain('owner is typing a private note')
  expect(seen).not.toContain('owner is typing a private note')
  expect(seen).not.toContain('"tui.prompt.append"')
  expect(seen).not.toContain('"tui.toast.show"')
})

test("a viewer's stream carries no unsessioned kind outside the allow-list", async () => {
  const seen = await fullCycle('/global/event')
  for (const [name] of LEAKY_GLOBAL_EVENTS) {
    const kind = name.split(' ')[0]!
    if (kind === 'session.error') continue // dropped, but its kind is not in the frame text
    expect(seen, `${kind} reached the viewer`).not.toContain(`"${kind}"`)
  }
  expect(seen).not.toContain('/home/owner/private/path')
  expect(seen).not.toContain('owner-secret-feature')
})

test('the allow-listed kinds still reach the viewer', async () => {
  const seen = await fullCycle('/event')
  expect(seen).toContain('"vcs.branch.updated"')
  expect(seen).toContain('"file.watcher.updated"')
  expect(seen).toContain('"server.heartbeat"')
})
