import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import http, { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import vm from 'node:vm'
import request from 'supertest'
import { createApp, startServer } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'
import { config } from '../src/config'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * A viewer whose access ends while the page is open must be taken back to the
 * way in, not left on a page that has quietly stopped working.
 *
 * The relay revokes correctly: an expired token, an evicted one or a deleted
 * share gets its stream ended on the next heartbeat and 401 on every request.
 * But the viewer UI is the upstream opencode web app, and it knows nothing of
 * 401. Its event reader treats one as a failed attempt and retries forever on a
 * 3 s, 6 s, 12 s, 24 s, then 30 s backoff; a prompt just toasts "401
 * Unauthorized" and stays in the input. Observed in a browser: the page sat
 * there, URL unchanged, for as long as it was left open, with nothing telling
 * the viewer that entering the code again was all it took. The relay's own
 * routes know where to send them, but only on a document load, which never
 * came.
 *
 * So the relay marks the 401s it answers itself, and the UI shell it serves
 * carries a small guard that turns a marked 401 into that load. The marker is
 * what keeps it safe: the owner's own opencode can answer 401 too (its provider
 * auth), with the viewer's cookie perfectly valid, and reloading on THAT would
 * loop for ever.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

/** What the relay sets on the 401 it answers for a viewer it does not know. */
const MARKER = 'x-oc-relay-auth'
const MARKER_VALUE = 'viewer-invalid'

/** The guard's once-per-window record in the tab's sessionStorage. */
const GUARD_KEY = 'oc-relay-auth-redirect-at'

let relay: Server
let opencode: Server
let bridge: RelayWSClient
let bridgeToken: string
let cookie: string

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"type":"server.connected","properties":{}}\n\n')
      return
    }
    // The owner's opencode refusing something on its own account.
    if (url.pathname === '/provider/auth') return json(res, 401, { error: 'unauthorized' })
    json(res, 200, { ok: true })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  const opencodePort = (opencode.address() as AddressInfo).port

  relay = await startServer(0)
  const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`

  const created = await request(relay)
    .post('/api/sessions')
    .send({ session_id: 'ses_guard1', directory: '/work', title: 't' })
  expect(created.status).toBe(201)
  bridgeToken = created.body.bridge_token
  const activated = await request(relay)
    .post('/api/activate')
    .send({ code: created.body.access_code, session_id: 'ses_guard1' })
  expect(activated.status).toBe(200)
  cookie = `viewer_token=${activated.body.viewer_token}`

  bridge = new RelayWSClient(relayUrl, new OpencodeClient(`http://127.0.0.1:${opencodePort}`, 'opencode', ''))
  await bridge.connect('ses_guard1', bridgeToken)
})

afterAll(async () => {
  bridge.close()
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

afterEach(() => {
  vi.useRealTimers()
})

/** The UI's canonical session URL for a share in /work. */
const uiPath = (id: string) => `/${Buffer.from('/work').toString('base64url')}/session/${id}`

/** A GET as the page's own fetch would see it: a real Response, body unread. */
async function pageFetch(target: Server | http.RequestListener, viewerCookie: string, path: string): Promise<Response> {
  const res = await request(target).get(path).set('Cookie', viewerCookie)
  const headers = new Headers()
  for (const [name, value] of Object.entries(res.headers)) {
    if (typeof value === 'string') headers.set(name, value)
  }
  return new Response(res.text, { status: res.status, headers })
}

/**
 * Load the served UI shell's guard the way a browser runs it: the script text
 * exactly as served, in a fresh global holding the page's fetch, location and
 * the tab's sessionStorage (shared across loads, like the real one).
 */
function loadPage(
  html: string,
  pathname: string,
  underlying: (path: string) => Promise<Response>,
  tab: Map<string, string>,
) {
  const script = /<script id="oc-relay-auth-guard">([\s\S]*?)<\/script>/.exec(html)?.[1]
  if (script === undefined) throw new Error('no auth guard in the served UI shell')
  const replace = vi.fn()
  const reload = vi.fn()
  let last: Response | undefined
  const page: Record<string, unknown> = {
    fetch: async (path: string) => (last = await underlying(path)),
    location: { pathname, replace, reload },
    sessionStorage: {
      getItem: (key: string) => tab.get(key) ?? null,
      setItem: (key: string, value: string) => void tab.set(key, String(value)),
      removeItem: (key: string) => void tab.delete(key),
    },
  }
  page.window = page
  vm.createContext(page)
  vm.runInContext(script, page)
  return {
    fetch: (path: string) => (page.fetch as (path: string) => Promise<Response>)(path),
    location: page.location as { pathname: string },
    navigations: () => [...replace.mock.calls.map(([to]) => String(to)), ...reload.mock.calls.map(() => '(reload)')],
    lastUnderlying: () => last,
  }
}

test('the 401s the relay answers itself are marked as the relay\'s', async () => {
  const forged = 'viewer_token=not-a-real-token'
  for (const [method, path] of [
    ['GET', '/session/ses_guard1'],
    ['GET', '/global/event'],
    ['GET', '/event'],
    ['POST', '/session/ses_guard1/prompt_async'],
  ] as const) {
    const res =
      method === 'GET'
        ? await request(relay).get(path).set('Cookie', forged)
        : await request(relay).post(path).set('Cookie', forged).send({ parts: [] })
    expect(res.status, `${method} ${path}`).toBe(401)
    expect(res.headers[MARKER], `${method} ${path}`).toBe(MARKER_VALUE)
  }
})

test('a 401 from the owner\'s own opencode is passed on unmarked, and the viewer is still in', async () => {
  const res = await request(relay).get('/provider/auth').set('Cookie', cookie)
  expect(res.status).toBe(401)
  expect(res.headers[MARKER]).toBeUndefined()
  // The cookie is fine: a guard that navigated on this 401 would land right
  // back in the UI, get the same 401 and go round again.
  const shell = await request(relay).get(uiPath('ses_guard1')).set('Cookie', cookie)
  expect(shell.status).toBe(200)
})

test('the UI shell sends a viewer whose share was deleted back to that share\'s page', async () => {
  const shell = await request(relay).get(uiPath('ses_guard1')).set('Cookie', cookie)
  expect(shell.status).toBe(200)
  // Classic inline script in <head>: it runs during parsing, before the UI's
  // deferred module bundle ever calls fetch.
  const guardAt = shell.text.indexOf('<script id="oc-relay-auth-guard">')
  expect(guardAt).toBeGreaterThan(-1)
  expect(guardAt).toBeLessThan(shell.text.indexOf('</head>'))

  const tab = new Map<string, string>()
  const page = loadPage(shell.text, uiPath('ses_guard1'), (path) => pageFetch(relay, cookie, path), tab)

  // The owner's opencode refusing something is not the viewer's access ending.
  expect((await page.fetch('/provider/auth')).status).toBe(401)
  expect(page.navigations()).toEqual([])

  const deleted = await request(relay).delete('/api/sessions/ses_guard1').set('x-bridge-token', bridgeToken)
  expect(deleted.status).toBe(204)
  // Meanwhile the UI moved on by itself, to a path naming another session (a
  // subagent's). That id is no share: its page would say "ended" for a share
  // that may be live. The page the relay served this shell at names the share.
  page.location.pathname = uiPath('ses_guard1child')

  // The event reader's reconnect after the heartbeat ended its stream.
  const res = await page.fetch('/global/event')
  expect(res.status).toBe(401)
  // Handed back untouched: the same Response, its body not read.
  expect(res).toBe(page.lastUnderlying())
  expect(res.bodyUsed).toBe(false)
  expect(page.navigations()).toEqual(['/ses_guard1'])

  // Every other request failing alongside it does not navigate again.
  await page.fetch('/session/ses_guard1/todo')
  expect(page.navigations()).toEqual(['/ses_guard1'])

  // Where that lands: the share is gone, and the page says so.
  const landing = await request(relay).get('/ses_guard1').set('Cookie', cookie)
  expect(landing.status).toBe(404)
  expect(landing.text).toContain('This session has ended')

  // A load in the same tab that still meets a marked 401 inside the window
  // (the cookie changed under it, say) stays put rather than bouncing between
  // pages; once the window has passed it tries again.
  const again = loadPage(shell.text, uiPath('ses_guard1'), (path) => pageFetch(relay, cookie, path), tab)
  await again.fetch('/global/event')
  expect(again.navigations()).toEqual([])
  tab.set(GUARD_KEY, String(Date.now() - 10 * 60_000))
  await again.fetch('/global/event')
  expect(again.navigations()).toEqual(['/ses_guard1'])
})

test('a viewer whose access expired lands on the code-entry page for their share, not the generic one', async () => {
  // Its own store and app: the clock jumps a day here, and no bridge link
  // should be around to see it.
  const store = new Store()
  const server = http.createServer()
  const links = new BridgeClient(server, store)
  const app = createApp(store, links)
  try {
    const { access_code } = store.createSession('ses_guard2', '/work', 't', '127.0.0.1')
    const { viewer_token } = store.activate(access_code, 'ses_guard2')
    const own = `viewer_token=${viewer_token}`

    vi.useFakeTimers({ toFake: ['Date'] })
    const shell = await request(app).get(uiPath('ses_guard2')).set('Cookie', own)
    expect(shell.status).toBe(200)
    const page = loadPage(shell.text, uiPath('ses_guard2'), (path) => pageFetch(app, own, path), new Map())

    vi.setSystemTime(Date.now() + config.viewerIdleTtlMs + 1000)
    const res = await page.fetch('/global/event')
    expect(res.status).toBe(401)
    expect(page.navigations()).toEqual(['/ses_guard2'])

    // The share is live, so its page offers the code field for THIS share...
    const landing = await request(app).get('/ses_guard2').set('Cookie', own)
    expect(landing.status).toBe(200)
    expect(landing.text).toContain('window.__OC_SESSION_ID__="ses_guard2"')
    // ...which the root cannot: with the expired cookie it names no share, and
    // the generic page it sends to has its code field disabled.
    const root = await request(app).get('/').set('Cookie', own)
    expect(root.headers.location).toBe('/join')
  } finally {
    links.close()
  }
})
