import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * A proxied body must not become a file download named by whoever sent it.
 *
 * The body and its Content-Type come from the bridge, which anyone may be. The
 * content-type allow-list and the sandbox CSP stop it EXECUTING on the relay
 * origin, but nothing stopped it being SAVED from there: the browser names a
 * download after the last path segment or the link's `download` attribute, so a
 * malicious share whose transcript links to /session/<its own
 * id>/message/Q3-invoice.hta had the viewer download the attacker's bytes, from
 * the relay's own domain, under that name — with the domain's reputation and
 * the Mark-of-the-Web that comes with it (verified in Chromium for a markdown
 * link, a target=_blank anchor and a `download` anchor).
 *
 * Two answers, both pinned here: a proxied API path is not something to
 * navigate to, and every proxied body carries a fixed Content-Disposition, so
 * the name is the relay's to choose and not the sender's.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

let server: http.Server
let store: Store
let bridge: BridgeClient
let base: string
const sockets: WebSocket[] = []

const PAYLOAD = '<script>new ActiveXObject("WScript.Shell").Run("calc")</script>'

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

/** A share whose "bridge" answers every proxied request with the attacker's body. */
async function hostileShare(session_id: string) {
  const res = await fetch(`http://${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.31' },
    body: JSON.stringify({ session_id, directory: '/w', title: 't' }),
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
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as { type?: string; request_id?: string }
    if (msg.type !== 'proxy') return
    ws.send(
      JSON.stringify({
        type: 'proxy_response',
        request_id: msg.request_id,
        status: 200,
        contentType: 'application/octet-stream',
        body: PAYLOAD,
      }),
    )
  })
  const { viewer_token } = store.activate(access_code, session_id)
  return { viewer_token }
}

// supertest, not fetch: Node's fetch rewrites Sec-Fetch-Mode (a forbidden
// header) to 'cors', so only a raw client can pose as a navigating browser.
test('a navigation to a proxied path gets nothing to download', async () => {
  const { viewer_token } = await hostileShare('ses_dl1')
  const res = await request(server)
    .get('/session/ses_dl1/message/Q3-invoice.hta')
    .set('x-viewer-token', viewer_token)
    .set('Sec-Fetch-Mode', 'navigate')
    .set('Sec-Fetch-Dest', 'document')
  expect(res.status).toBe(404)
  expect(res.text).not.toContain('ActiveXObject')
})

test('a proxied body the UI does fetch is named by the relay, not by the path', async () => {
  const { viewer_token } = await hostileShare('ses_dl2')
  const res = await request(server)
    .get('/session/ses_dl2/message/Q3-invoice.hta')
    .set('x-viewer-token', viewer_token)
    .set('Sec-Fetch-Mode', 'cors')
  expect(res.status).toBe(200)
  // Fixed, so neither the last path segment nor a link's `download` attribute
  // decides what the file is called: the header wins over both.
  expect(res.headers['content-disposition']).toBe('attachment; filename="response.bin"')
  // The rest of the lock-down is untouched.
  expect(res.headers['cache-control']).toBe('private, no-store')
  expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
})

test('the event stream is not a download and keeps working', async () => {
  const { viewer_token } = await hostileShare('ses_dl3')
  const ac = new AbortController()
  const res = await fetch(`http://${base}/event`, {
    headers: { 'x-viewer-token': viewer_token, 'Sec-Fetch-Mode': 'cors' },
    signal: ac.signal,
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  expect(res.headers.get('content-disposition')).toBeNull()
  ac.abort()
})
