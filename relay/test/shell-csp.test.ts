import { afterEach, expect, test } from 'vitest'
import request from 'supertest'
import { createHash } from 'node:crypto'
import { createApp } from '../src/server'
import { Store } from '../src/store'

/**
 * The relay's own HTML shells (the UI shell, the join page, the ended page)
 * carry inline <script>s the relay injects — SERVER_URL_RESET, authGuard,
 * draftsReset, join's __OC_SESSION_ID__ — beside the upstream index.html's
 * theme preload. With RELAY_SHELL_CSP on, each shell gets a Content-Security-
 * Policy whose script-src lists a sha256 hash of every inline script it carries
 * (so a tampered or injected inline script is refused) plus 'self' for the SPA
 * bundle, and locks object-src/base-uri/frame-ancestors down. The flag defaults
 * OFF: the upstream SPA's full runtime needs must be browser-verified on prod
 * before it is turned on, and a rolling deploy must not add a CSP unasked.
 */

const DIR = '/work'
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

/** Parse a CSP header into directive -> source list. */
function parseCsp(header: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of (header ?? '').split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const [name, ...src] = trimmed.split(/\s+/)
    out.set(name.toLowerCase(), src)
  }
  return out
}

/** The CSP source-expression a browser would compute for a script's inner text. */
function hashOf(body: string): string {
  return `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`
}

/** Inner text of every inline (no-src) <script> in an HTML string. */
function inlineScriptBodies(html: string): string[] {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  const out: string[] = []
  for (const m of html.matchAll(re)) {
    if (/\bsrc\s*=/i.test(m[1])) continue
    out.push(m[2])
  }
  return out
}

const PREV = process.env.RELAY_SHELL_CSP
afterEach(() => {
  if (PREV === undefined) delete process.env.RELAY_SHELL_CSP
  else process.env.RELAY_SHELL_CSP = PREV
})

test('the UI shell CSP hashes every injected inline script and locks the rest down', async () => {
  process.env.RELAY_SHELL_CSP = '1'
  const store = new Store()
  const app = createApp(store)
  const { access_code } = store.createSession('ses_csp1', DIR, 't', '127.0.0.1')
  const { viewer_token } = store.activate(access_code, 'ses_csp1')
  const res = await request(app)
    .get(`/${b64url(DIR)}/session/ses_csp1`)
    .set('Cookie', `viewer_token=${viewer_token}`)
  expect(res.status).toBe(200)

  const csp = parseCsp(res.headers['content-security-policy'])
  const scriptSrc = csp.get('script-src') ?? []
  expect(scriptSrc).toContain("'self'")
  expect(scriptSrc).toContain("'wasm-unsafe-eval'")
  expect(csp.get('object-src')).toEqual(["'none'"])
  expect(csp.get('base-uri')).toEqual(["'none'"])
  expect(csp.get('frame-ancestors')).toEqual(["'none'"])

  // theme preload + SERVER_URL_RESET + draftsReset + authGuard.
  const bodies = inlineScriptBodies(res.text)
  expect(bodies.length).toBeGreaterThanOrEqual(4)
  for (const body of bodies) expect(scriptSrc).toContain(hashOf(body))
  // A tampered inline script — even one extra byte — is not covered by any
  // hash, so the browser would block it.
  for (const body of bodies) expect(scriptSrc).not.toContain(hashOf(`${body} `))
})

test('the join page CSP hashes its form handler and the __OC_SESSION_ID__ inject', async () => {
  process.env.RELAY_SHELL_CSP = '1'
  const store = new Store()
  store.createSession('ses_csp2', DIR, 't', '127.0.0.1')
  const app = createApp(store)
  // No viewer cookie -> the session's code-entry page (joinHtml with its id).
  const res = await request(app).get('/ses_csp2')
  expect(res.status).toBe(200)

  const scriptSrc = parseCsp(res.headers['content-security-policy']).get('script-src') ?? []
  const bodies = inlineScriptBodies(res.text)
  expect(bodies.length).toBeGreaterThanOrEqual(2)
  for (const body of bodies) expect(scriptSrc).toContain(hashOf(body))
})

test('the ended page carries the shell CSP when enabled', async () => {
  process.env.RELAY_SHELL_CSP = 'on'
  const res = await request(createApp(new Store())).get('/ses_doesnotexist000000000')
  expect(res.status).toBe(404)
  const csp = parseCsp(res.headers['content-security-policy'])
  expect(csp.get('object-src')).toEqual(["'none'"])
  expect(csp.get('frame-ancestors')).toEqual(["'none'"])
})

test('no CSP is added to the shells by default (opt-in, backward compatible)', async () => {
  delete process.env.RELAY_SHELL_CSP
  const app = createApp(new Store())
  for (const url of ['/terminal', '/join']) {
    const res = await request(app).get(url)
    expect(res.headers['content-security-policy'], url).toBeUndefined()
  }
})
