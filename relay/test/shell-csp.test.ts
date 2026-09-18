import { afterEach, expect, test, vi } from 'vitest'
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
 * (so the header never drifts from the scripts the shell carries) plus 'self'
 * for the SPA bundle, and locks object-src/base-uri/frame-ancestors down. The
 * hashes cover the response's own bytes, so they pin the header to the body —
 * they are not a guard against script injected into the shell. The flag defaults
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
  // The list is exactly the scripts served and nothing more: a body differing
  // by even one byte has no hash, so the browser would block it.
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

// The flag exists to be switched on by hand at rollout, so a typo there is the
// one moment that matters: the shells stay as they were (fail-closed), but the
// relay has to say so rather than let the coordinator believe CSP is live.
test('an unrecognised RELAY_SHELL_CSP keeps the default and warns', async () => {
  process.env.RELAY_SHELL_CSP = 'enabled'
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const res = await request(createApp(new Store())).get('/join')
    expect(res.headers['content-security-policy']).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(said).toContain('RELAY_SHELL_CSP')
    // The name and the state actually applied, never the offending value.
    expect(said).not.toContain('enabled')
  } finally {
    warn.mockRestore()
  }
})

/**
 * Every HTML document a viewer can reach has to come from sendShell — the one
 * place that attaches the CSP and injects SERVER_URL_RESET/draftsReset/
 * authGuard. express.static sat in front of those routes and handed out
 * PUBLIC_DIR/index.html and join.html verbatim: under their own names, under a
 * percent-encoded spelling of them, and as the directory index for '//'. So the
 * shells were reachable raw, with no CSP and none of the injected scripts, and
 * turning RELAY_SHELL_CSP on would not have covered those paths at all.
 */
test('no HTML document is served without the shell CSP', async () => {
  process.env.RELAY_SHELL_CSP = '1'
  const store = new Store()
  const app = createApp(store)
  const { access_code } = store.createSession('ses_csp3', DIR, 't', '127.0.0.1')
  const { viewer_token } = store.activate(access_code, 'ses_csp3')
  const paths = ['/index.html', '/join.html', '/%69ndex.html', '//', '/terminal', '/join', '/ses_csp3']
  for (const p of paths) {
    const res = await request(app).get(p).set('Cookie', `viewer_token=${viewer_token}`)
    if (!String(res.headers['content-type'] ?? '').includes('text/html')) continue
    expect(res.headers['content-security-policy'], `${p} answered HTML with no CSP`).toBeDefined()
  }
})

/**
 * And they are gone whatever the flag says: a raw shell also skips authGuard,
 * which is what sends a viewer without a usable cookie to their code-entry
 * page. _headers is the upstream build's deploy-time header config, which no
 * browser here reads; it goes the same way as the source maps.
 */
test('the static layer serves no HTML document and no build config of its own', async () => {
  delete process.env.RELAY_SHELL_CSP
  const app = createApp(new Store())
  for (const p of ['/index.html', '/join.html', '/%69ndex.html', '//', '/_headers']) {
    const res = await request(app).get(p)
    expect(res.status, p).toBe(404)
    expect(String(res.headers['content-type'] ?? ''), p).toContain('application/json')
  }
})
