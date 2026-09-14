import { expect, test } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'

/**
 * Every relay response says which powerful browser features its page may use,
 * and keeps its window and its resources to this origin.
 *
 * The hardening middleware set nosniff, X-Frame-Options and Referrer-Policy
 * and nothing else, and nginx adds only HSTS: a local relay answered /join,
 * the UI shell, /terminal, the hashed bundles, the health probes, the proxy's
 * 401 and the JSON 404 with no Permissions-Policy, no Cross-Origin-Opener-
 * Policy and no Cross-Origin-Resource-Policy. Nothing exploits that today
 * (framing is already refused, the UI creates no iframes, camera and
 * microphone still prompt), so this is defence in depth: a page that holds a
 * share's session should not be able to reach the camera, the microphone or
 * the clipboard's contents, keep a handle on a cross-origin opener, or have
 * its bundles and API answers pulled into another site's page.
 *
 * The policy is NOT deny-all. The UI's copy buttons (copy path, copy link,
 * copyable text fields, the terminal) call navigator.clipboard.writeText, and
 * measured in Chromium with the clipboard permission granted: under
 * clipboard-write=() that call rejects with NotAllowedError ("blocked because
 * of a permissions policy"), under clipboard-write=(self) it succeeds. The
 * test holds that line so a later "deny everything" edit cannot silently
 * break copying.
 */

/** A Permissions-Policy header as feature -> allowlist, e.g. camera -> "()". */
function parsePolicy(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const item of (header ?? '').split(',')) {
    const eq = item.indexOf('=')
    if (eq === -1) continue
    out.set(item.slice(0, eq).trim(), item.slice(eq + 1).trim())
  }
  return out
}

// Features the UI bundle never calls (checked against its build): denied to
// the document and to anything it might ever embed.
const DENIED = ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'clipboard-read']

const DIR = '/work'
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

test('every response carries a Permissions-Policy that denies unused features but lets the UI copy, and same-origin COOP and CORP', async () => {
  const store = new Store()
  const app = createApp(store)
  const { access_code } = store.createSession('ses_pp1', DIR, 't', '127.0.0.1')
  const { viewer_token } = store.activate(access_code, 'ses_pp1')
  const cookie = `viewer_token=${viewer_token}`

  const cases: Array<[string, () => request.Test]> = [
    ['GET /join', () => request(app).get('/join')],
    ['GET /ses_pp1 (join page)', () => request(app).get('/ses_pp1')],
    ['GET UI shell', () => request(app).get(`/${b64url(DIR)}/session/ses_pp1`).set('Cookie', cookie)],
    ['GET /terminal', () => request(app).get('/terminal')],
    ['GET /index.html', () => request(app).get('/index.html')],
    ['GET /api/health', () => request(app).get('/api/health')],
    ['GET /health', () => request(app).get('/health')],
    ['GET /session (proxy, no cookie)', () => request(app).get('/session')],
    ['POST /api/activate (bad body)', () => request(app).post('/api/activate').send({})],
    ['GET /nope (404)', () => request(app).get('/nope')],
  ]
  for (const [name, send] of cases) {
    const res = await send()
    const policy = parsePolicy(res.headers['permissions-policy'])
    for (const feature of DENIED) expect(policy.get(feature), `${name}: ${feature}`).toBe('()')
    const clipboardWrite = policy.get('clipboard-write')
    expect(
      clipboardWrite === undefined || clipboardWrite.includes('self'),
      `${name}: clipboard-write=${clipboardWrite}`,
    ).toBe(true)
    expect(res.headers['cross-origin-opener-policy'], name).toBe('same-origin')
    expect(res.headers['cross-origin-resource-policy'], name).toBe('same-origin')
  }
})
