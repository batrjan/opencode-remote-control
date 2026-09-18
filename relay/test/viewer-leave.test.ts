import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { viewerTokenFrom } from './helpers/viewer-token'
import { startServer } from '../src/server'
import { Store } from '../src/store'
import { config } from '../src/config'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * A viewer can end their own access, and no token lives forever.
 *
 * The relay revoked a viewer in every way EXCEPT at the viewer's own request:
 * the share could be stopped, the seat evicted, the token aged out of its idle
 * window — but the person holding it had no way to hand it back. Someone who
 * joined from a borrowed laptop, a conference machine or a colleague's browser
 * left a live credential behind, and the only cure was asking the owner to end
 * the share for everyone. The idle window SLIDES, so a tab left open kept the
 * token alive indefinitely; with the tab closed the residue was still a day.
 *
 * POST /api/leave answers that: it drops exactly that token and clears the
 * cookie, and what is left behind is refused everywhere a revoked token is —
 * the proxy, the event stream, the shell routes. config.viewerMaxLifetimeMs is
 * the other half: an absolute ceiling over the sliding window, so a token that
 * is used forever still ends.
 */

process.env.RELAY_SSE_HEARTBEAT_MS = '80'
process.env.ACTIVATE_FAIL_DELAY_MS = '0'

let relay: Server
let relayUrl: string
let opencode: Server
let bridge: RelayWSClient
let accessCode: string

const SHARE = 'ses_leave1'

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"type":"server.connected","properties":{}}\n\n')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  const opencodePort = (opencode.address() as AddressInfo).port

  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`

  const created = await request(relay).post('/api/sessions').send({ session_id: SHARE, directory: '/work', title: 't' })
  expect(created.status).toBe(201)
  accessCode = created.body.access_code

  bridge = new RelayWSClient(relayUrl, new OpencodeClient(`http://127.0.0.1:${opencodePort}`, 'opencode', ''))
  await bridge.connect(SHARE, created.body.bridge_token)
})

afterAll(async () => {
  bridge.close()
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

/** A fresh viewer of the share, as a browser gets one: one more activation. */
async function join(): Promise<string> {
  const activated = await request(relay).post('/api/activate').send({ code: accessCode, session_id: SHARE })
  expect(activated.status).toBe(200)
  return viewerTokenFrom(activated)
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('a viewer can hand their token back, and the cookie goes with it', async () => {
  const token = await join()
  const res = await request(relay).post('/api/leave').set('Cookie', `viewer_token=${token}`)
  expect(res.status).toBe(204)
  const set = res.headers['set-cookie'] as string | string[] | undefined
  const cookies = set === undefined ? [] : Array.isArray(set) ? set : [set]
  const cleared = cookies.find((c) => c.startsWith('viewer_token='))
  expect(cleared, 'no Set-Cookie cleared the viewer cookie').toBeDefined()
  expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i)
})

/**
 * Clear-Site-Data's "cookies" directive is defined over the REGISTRABLE DOMAIN
 * of the responding origin, not over the origin ("we remove all the cookies for
 * an entire registered domain" — w3c/webappsec-clear-site-data). Verified in
 * Chromium: a 204 from one host wiped the host-only cookies of two neighbouring
 * hosts sharing its registrable domain. On a relay at opencode.example.com that
 * is every other service under example.com, none of which this endpoint has any
 * business logging anyone out of — and the relay's own cookie is taken back by
 * clearViewerCookie above, by name, path and attributes.
 */
test("leaving clears this origin's data, not the cookies of neighbouring subdomains", async () => {
  const token = await join()
  const res = await request(relay).post('/api/leave').set('Cookie', `viewer_token=${token}`)
  expect(res.status).toBe(204)
  const csd = String(res.headers['clear-site-data'] ?? '')
  expect(csd, 'the header reaches past this origin').not.toContain('cookies')
  // What it is actually for: the UI state this origin holds for the share being
  // left — drafts and prompt history in IndexedDB, settings in localStorage.
  expect(csd).toContain('storage')
  // And the one cookie that does have to go still goes, on its own header.
  const set = res.headers['set-cookie'] as string | string[] | undefined
  const cookies = set === undefined ? [] : Array.isArray(set) ? set : [set]
  expect(cookies.find((c) => c.startsWith('viewer_token='))).toBeDefined()
})

test('what is left of the token is refused by the proxy and the shell routes', async () => {
  const token = await join()
  expect((await request(relay).get('/config').set('x-viewer-token', token)).status).toBe(200)

  expect((await request(relay).post('/api/leave').set('Cookie', `viewer_token=${token}`)).status).toBe(204)

  const proxied = await request(relay).get('/config').set('x-viewer-token', token)
  expect(proxied.status, 'the proxy still answered a handed-back token').toBe(401)
  expect(proxied.headers['x-oc-relay-auth']).toBe('viewer-invalid')

  // The share page is the code-entry page again, not a redirect into the UI.
  const page = await request(relay).get(`/${SHARE}`).set('Cookie', `viewer_token=${token}`)
  expect(page.status, 'the shell route still let the token in').toBe(200)
  expect(page.text).toContain('__OC_SESSION_ID__')

  // And the root no longer knows where to send it.
  const home = await request(relay).get('/').set('Cookie', `viewer_token=${token}`)
  expect(home.headers.location).toBe('/join')
})

test('an event stream already open ends when its viewer leaves', async () => {
  const token = await join()
  const controller = new AbortController()
  const res = await fetch(`${relayUrl}/event`, {
    headers: { 'x-viewer-token': token, accept: 'text/event-stream' },
    signal: controller.signal,
  })
  expect(res.status).toBe(200)
  let ended = false
  const reader = res.body!.getReader()
  void (async () => {
    try {
      for (;;) if ((await reader.read()).done) break
    } catch {
      // aborted or dropped — either way it is over
    } finally {
      ended = true
    }
  })()

  expect(ended).toBe(false)
  expect((await request(relay).post('/api/leave').set('Cookie', `viewer_token=${token}`)).status).toBe(204)
  await settle(500)
  expect(ended, 'the handed-back viewer kept its live feed').toBe(true)
  controller.abort()
})

test('leaving is refused from another origin, so no site can log a viewer out', async () => {
  const token = await join()
  const res = await request(relay)
    .post('/api/leave')
    .set('Cookie', `viewer_token=${token}`)
    .set('Origin', 'https://evil.example')
  expect(res.status).toBe(403)
  expect((await request(relay).get('/config').set('x-viewer-token', token)).status).toBe(200)
})

test('leaving with no token at all is still an answer, not an error', async () => {
  expect((await request(relay).post('/api/leave')).status).toBe(204)
})

// The idle window slides on every use, so a token in daily use never reached
// it: the only bound on a viewer's access was the life of the share.
test('a token stops working at the absolute lifetime however often it is used', () => {
  expect(config.viewerMaxLifetimeMs).toBeGreaterThan(config.viewerIdleTtlMs)
  const id = 'ses_agecap0000000000000'
  const store = new Store()
  const { access_code } = store.createSession(id, '/work', 't', '198.51.100.4')
  const { viewer_token } = store.activate(access_code, id)
  expect(store.verifyViewer(id, viewer_token)).toBe(true)

  // Carried across a restart with the clock wound back past the ceiling on the
  // token's creation, and used as recently as a second ago — the shape of a tab
  // that has been open for weeks.
  const state = store.snapshot()
  const now = Date.now()
  for (const s of state.sessions) {
    s.last_seen = now
    for (const v of s.viewers) {
      v.created_at = now - config.viewerMaxLifetimeMs - 60_000
      v.last_used = now - 1_000
    }
  }
  const after = new Store()
  expect(after.restore(state)).toBe(1)
  expect(after.verifyViewer(id, viewer_token), 'a token past its absolute lifetime still authenticated').toBe(false)
  expect(after.getSessionByViewerToken(viewer_token)).toBeUndefined()
})
