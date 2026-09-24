import { afterEach, expect, test } from 'vitest'
import http from 'node:http'
import vm from 'node:vm'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'
import { VIEWER_SHARE_HEADER } from '../src/proxy/adapter'

/**
 * A tab open on one share must not silently drive another one.
 *
 * Every share is served from the relay's single origin and the viewer cookie is
 * one per origin, so joining share A in one tab replaces the token of share B in
 * every other tab of that profile. The routes that carry no :id of their own —
 * /permission, /question, /config, /provider, /session/status, /event — are then
 * answered from whichever share wrote the cookie last: B's tab reads A's
 * pending permission prompts, and answers them.
 *
 * The relay has always refused a request that NAMES a share other than the
 * token's (VIEWER_SHARE_HEADER, checked in requireViewer). Nothing sent it: the
 * check was half a mechanism, and the shell the relay serves is the half that
 * was missing. The guard it injects already knows which share the page belongs
 * to — the relay names it as it serves the page — so it says so on every
 * same-origin request the page makes, and the mismatch is refused with the
 * marked 401 that sends the tab back to its own code-entry page.
 *
 * Same-origin only: a custom header on a cross-origin request would force a
 * CORS preflight the UI never asked for.
 */

const DIR = '/work'
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const uiPath = (id: string) => `/${b64url(DIR)}/session/${id}`
const ORIGIN = 'https://relay.example'

const closers: (() => void)[] = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
})

/**
 * Two shares on one relay, with the proxy routes mounted (they exist only when
 * a bridge hub does). No bridge ever connects: what matters here is whether the
 * relay accepts the request as this viewer's at all, which it decides before it
 * reaches for one.
 */
function twoShares() {
  const store = new Store()
  const server = http.createServer()
  const bridge = new BridgeClient(server, store)
  closers.push(() => bridge.close())
  const app = createApp(store, bridge)
  const viewer = (id: string) => {
    const { access_code } = store.createSession(id, DIR, 't', '127.0.0.1')
    const { viewer_token } = store.activate(access_code, id)
    return `viewer_token=${viewer_token}`
  }
  return { app, a: viewer('ses_shellA'), b: viewer('ses_shellB') }
}

/** The inner text of one of the relay's injected inline scripts. */
function injectedScript(html: string, id: string): string {
  const found = new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`).exec(html)
  expect(found, `no <script id="${id}"> in the served shell`).not.toBeNull()
  return found![1]!
}

/**
 * The served shell's guard, running in a page: its own window, its own
 * location, and a fetch of our own underneath it. `send` is what the page's
 * fetch resolves to — the relay's real answer, or a canned one.
 */
function loadGuard(html: string, send: (req: Request) => Promise<Response>) {
  const sent: Request[] = []
  const navigated: string[] = []
  const page: Record<string, unknown> = {
    location: { origin: ORIGIN, replace: (to: string) => void navigated.push(to) },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: (...args: unknown[]) => {
      // Whatever the guard hands the original fetch, as the browser would see it.
      const req = args[0] instanceof Request ? args[0] : new Request(String(args[0]), args[1] as RequestInit)
      sent.push(req)
      return send(req)
    },
    // A page's globals the guard uses; a vm context has the language's, not the
    // web platform's.
    Request,
    Response,
    Headers,
    URL,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  }
  page.window = page
  vm.createContext(page)
  vm.runInContext(injectedScript(html, 'oc-relay-auth-guard'), page)
  const fetch = page.fetch as (input: string | Request, init?: RequestInit) => Promise<Response>
  return { fetch, sent, navigated }
}

test("the shell the relay serves names its own share on the page's requests", async () => {
  const { app, b } = twoShares()
  const shell = await request(app).get(uiPath('ses_shellB')).set('Cookie', b)
  expect(shell.status).toBe(200)
  // Cheap check first, so a shell that stopped naming its share is obvious.
  expect(shell.text).toContain(VIEWER_SHARE_HEADER)

  const ok = () => Promise.resolve(new Response(null, { status: 200 }))
  const page = loadGuard(shell.text, ok)

  await page.fetch(`${ORIGIN}/config`)
  expect(page.sent[0]?.headers.get(VIEWER_SHARE_HEADER), 'the page named no share').toBe('ses_shellB')

  // Every shape the UI calls fetch with, not just a bare URL.
  await page.fetch(`${ORIGIN}/session/ses_shellB/message`, { method: 'POST', body: '{"parts":[]}' })
  expect(page.sent[1]?.headers.get(VIEWER_SHARE_HEADER)).toBe('ses_shellB')
  expect(page.sent[1]?.method).toBe('POST')
  expect(await page.sent[1]!.text(), 'the body did not survive the wrapper').toBe('{"parts":[]}')

  await page.fetch(new Request(`${ORIGIN}/event`))
  expect(page.sent[2]?.headers.get(VIEWER_SHARE_HEADER)).toBe('ses_shellB')

  // Cross-origin is left alone: a custom header there costs a CORS preflight.
  await page.fetch('https://example.invalid/x')
  expect(page.sent[3]?.headers.get(VIEWER_SHARE_HEADER), 'a cross-origin request was given a custom header').toBeNull()
})

// /terminal belongs to no share (it is served without an id), so its guard has
// nothing to name — and naming nothing must not turn into naming something.
test('the share-less shell sends no share header at all', async () => {
  const { app, a } = twoShares()
  const shell = await request(app).get('/terminal').set('Cookie', a)
  expect(shell.status).toBe(200)
  const page = loadGuard(shell.text, () => Promise.resolve(new Response(null, { status: 200 })))
  await page.fetch(`${ORIGIN}/config`)
  expect(page.sent[0]?.headers.get(VIEWER_SHARE_HEADER)).toBeNull()
})

/**
 * The whole loop against the real relay: share B's page, driven by a cookie
 * that now holds share A's token — what a browser has the moment its owner
 * joins A in another tab.
 */
test("a tab of one share stops being answered from another share's token", async () => {
  const { app, a, b } = twoShares()
  const shell = await request(app).get(uiPath('ses_shellB')).set('Cookie', b)
  expect(shell.status).toBe(200)

  // The cookie is the profile's, and A joined last.
  const page = loadGuard(shell.text, async (req) => {
    const relayed = request(app).get(new URL(req.url).pathname).set('Cookie', a)
    for (const [name, value] of req.headers) relayed.set(name, value)
    const res = await relayed
    return new Response(null, { status: res.status, headers: res.headers as Record<string, string> })
  })

  const res = await page.fetch(`${ORIGIN}/config`)
  expect(res.status, "share B's tab was answered from share A").toBe(401)
  expect(res.headers.get('x-oc-relay-auth')).toBe('viewer-invalid')
  // And the refusal is the marked one, so the tab goes to its OWN share's
  // code-entry page instead of sitting on a dead screen.
  expect(page.navigated).toEqual(['/ses_shellB'])
})
