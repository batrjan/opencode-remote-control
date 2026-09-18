import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * A tab open on share B must never have its requests answered by share A.
 *
 * The viewer cookie is one per origin and every share is served from the same
 * one, so joining share A overwrites the token of share B in every tab of that
 * browser profile. The proxy then rewrote the :id of B's still-open tab to A's
 * session without a word: the prompt the viewer typed for their own colleague,
 * and the shell command that went with it, ran on a stranger's machine, and the
 * transcript that came back was that stranger's. Nothing in the answer said so
 * — no error, no marker — so the tab looked healthy until its next reload.
 *
 * The rewrite is what has to go. An id that is neither the viewer's own share
 * nor a proven descendant of it is refused with the marker the UI shell's guard
 * already understands (VIEWER_AUTH_HEADER), which sends that tab to ITS share's
 * code-entry page instead of into someone else's session.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

let server: http.Server
let store: Store
let bridge: BridgeClient
let base: string
const sockets: WebSocket[] = []

beforeEach(async () => {
  store = new Store()
  server = http.createServer()
  bridge = new BridgeClient(server, store)
  server.on('request', createApp(store, bridge))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate()
  bridge.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

/** A share whose bridge answers everything 200 and remembers what it was asked. */
async function share(session_id: string, ip: string) {
  const res = await fetch(`http://${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ session_id, directory: `/work/${session_id}`, title: 't' }),
  })
  expect(res.status).toBe(201)
  const { access_code, bridge_token } = (await res.json()) as { access_code: string; bridge_token: string }
  const ws = new WebSocket(`ws://${base}/bridge?session_id=${encodeURIComponent(session_id)}`, {
    headers: { 'x-bridge-token': bridge_token },
  })
  sockets.push(ws)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const asked: string[] = []
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as { type?: string; request_id?: string; method?: string; path?: string }
    if (msg.type !== 'proxy') return
    const path = new URL(msg.path ?? '', 'http://x').pathname
    asked.push(`${msg.method} ${path}`)
    // Only this session exists on this opencode; anything else is unknown.
    const body = path === `/session/${session_id}` ? { id: session_id } : { ok: true }
    ws.send(
      JSON.stringify({
        type: 'proxy_response',
        request_id: msg.request_id,
        status: path.startsWith('/session/ses_') && !path.startsWith(`/session/${session_id}`) ? 404 : 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      }),
    )
  })
  const { viewer_token } = store.activate(access_code, session_id)
  return { viewer_token, asked, ws }
}

const AUTH_HEADER = 'x-oc-relay-auth'
const AUTH_INVALID = 'viewer-invalid'

test("a tab whose cookie now names another share is refused, not silently rebound", async () => {
  const b = await share('ses_shareB', '203.0.113.21')
  const a = await share('ses_shareA', '203.0.113.22')
  // The browser profile joined A last, so this is the only token it still has.
  const cookie = `viewer_token=${a.viewer_token}`

  const prompt = await fetch(`http://${base}/session/ses_shareB/prompt_async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ parts: [{ type: 'text', text: 'db password hunter2' }] }),
  })
  const shell = await fetch(`http://${base}/session/ses_shareB/shell`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ agent: 'build', command: 'git push --force origin main' }),
  })
  const read = await fetch(`http://${base}/session/ses_shareB/message`, { headers: { cookie } })

  for (const res of [prompt, shell, read]) {
    expect(res.status).toBe(401)
    expect(res.headers.get(AUTH_HEADER)).toBe(AUTH_INVALID)
  }
  // Nothing of B's tab reached A's opencode: no prompt, no shell, no transcript.
  expect(a.asked.filter((r) => r.includes('prompt_async') || r.includes('/shell') || r.includes('/message'))).toEqual([])
  // And B's own owner, whose token this browser no longer holds, saw nothing either.
  expect(b.asked).toEqual([])
})

test('the viewer’s own share still works exactly as before', async () => {
  const a = await share('ses_ownA', '203.0.113.23')
  const cookie = `viewer_token=${a.viewer_token}`
  const prompt = await fetch(`http://${base}/session/ses_ownA/prompt_async`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ parts: [{ type: 'text', text: 'hello' }] }),
  })
  expect(prompt.status).toBe(200)
  expect(a.asked.some((r) => r === 'POST /session/ses_ownA/prompt_async')).toBe(true)
})

test('a route with no :id can name the tab’s share, and a mismatch is refused', async () => {
  const a = await share('ses_headerA', '203.0.113.24')
  const cookie = `viewer_token=${a.viewer_token}`
  // The tab of another share asking a share-less route (/permission, /config,
  // /event) would otherwise be answered from this cookie's share without a word.
  const foreign = await fetch(`http://${base}/permission`, {
    headers: { cookie, 'x-oc-relay-share': 'ses_headerB' },
  })
  expect(foreign.status).toBe(401)
  expect(foreign.headers.get(AUTH_HEADER)).toBe(AUTH_INVALID)

  const own = await fetch(`http://${base}/permission`, {
    headers: { cookie, 'x-oc-relay-share': 'ses_headerA' },
  })
  expect(own.status).toBe(200)
})

test('an id the relay could not check is a failed request, not a lost session', async () => {
  const a = await share('ses_awayA', '203.0.113.25')
  const cookie = `viewer_token=${a.viewer_token}`
  // The bridge is gone, so no walk can prove or disprove anything. A viewer
  // whose own token is perfectly good must not be sent to the code page for it.
  a.ws.terminate()
  await new Promise((resolve) => setTimeout(resolve, 100))
  const res = await fetch(`http://${base}/session/ses_awayOther/message`, { headers: { cookie } })
  expect(res.status).toBe(502)
  expect(res.headers.get(AUTH_HEADER)).toBeNull()
  // A share whose bridge is away answers nothing of its own either, so the tab
  // is not being told anything about the id it asked for.
  expect(a.asked.filter((r) => r.includes('/message'))).toEqual([])
}, 20_000)
