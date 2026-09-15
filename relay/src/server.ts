import express from 'express'
import type { Express } from 'express'
import http from 'node:http'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'
import type { Session } from './store.js'
import { activateRouter } from './api/activate.js'
import { setViewerCookie } from './api/viewerCookie.js'
import { healthRouter } from './api/health.js'
import { skillRouter } from './api/skill.js'
import { BridgeClient } from './ws/bridge.js'
import { proxyAdapter, VIEWER_AUTH_HEADER, VIEWER_AUTH_INVALID } from './proxy/adapter.js'
import { config, stateFile, trustProxy, shellCspEnabled } from './config.js'
import { FileStateStore } from './persist.js'

/**
 * Static viewer UI (opencode web dist + join page). Resolved relative to this
 * module so it works both from src/ (vitest) and dist/ (compiled): in both
 * cases the public dir is a sibling of the module's parent.
 */
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url))

/**
 * Which static files a browser may keep for a year without asking again.
 *
 * express.static's default is "public, max-age=0": stale on arrival, so a
 * viewer's every load revalidated each file (one round trip apiece, ahead of
 * the UI's boot), and the ETag it revalidates against is size+mtime — a
 * rebuilt image layer re-copies the UI build, and every returning viewer then
 * downloaded all of it again although not a byte had changed.
 *
 * The UI build names what it emits into /assets after the content (Vite's
 * -[hash8] suffix, base64url), so such a name always holds the same bytes.
 * Not everything there has one: Inter.ttf and the JetBrains Mono woff2 are
 * copied verbatim and referenced by fixed URL from the CSS, so they, the root
 * files and the HTML shells keep the default and keep revalidating — the
 * shells are what points a viewer at a deploy's new hashed names. A future
 * unhashed file whose name happens to end in -<8 name characters> (say
 * "-Variable.ttf") would be taken for hashed; the hash alphabet includes
 * plain words, so the name alone cannot tell them apart.
 */
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets') + path.sep
const HASHED_ASSET_NAME = /-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/
function isHashedAsset(filePath: string): boolean {
  return filePath.startsWith(ASSETS_DIR) && HASHED_ASSET_NAME.test(path.basename(filePath))
}

/**
 * Whether a request names one of the UI build's source maps, which the static
 * handler does not serve.
 *
 * The upstream Vite build leaves a .js.map beside every bundle in /assets, 835
 * of them and about 48 MB (the largest 11.5 MB), and express.static handed each
 * one to anyone who asked, no cookie needed: an anonymous client could make the
 * host send, and nginx gzip, 11.5 MB per request. No viewer needs them. The UI
 * never fetches one, and a browser asks only with DevTools open. They hold
 * the public upstream source, so this saves weight and bandwidth; it hides no
 * secret. The bundles keep their sourceMappingURL comments; a developer with
 * DevTools open sees a 404 for each.
 *
 * Checked on the decoded path, as the static handler decodes it before looking
 * on disk: /assets/x.js%2Emap and /%61ssets/x.js.map are the same file.
 * Case-insensitive, for a filesystem that is (a macOS checkout). A path that
 * does not decode is left to the handler, which refuses it with 400.
 */
function isSourceMapPath(urlPath: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return false
  }
  return /\.map$/i.test(decoded)
}

/** index.html split at </head>, where the shell's scripts go. */
let cachedShell: { head: string; tail: string } | undefined

/**
 * The official UI's index.html. The proxy adapter is mounted at the server
 * ROOT (see startServer), so the UI's default server URL is location.origin
 * — exactly how the real opencode web behaves when served by its own server.
 * No bootstrap/localStorage seeding is needed: absolute API paths
 * (/provider, /global/config, /session/...) all land on the root proxy.
 */
/**
 * Reset script injected into the UI at serve time. Earlier relay versions
 * seeded defaultServerUrl with an /api/opencode prefix; that value persists
 * in the viewer's localStorage and now produces a phantom second server
 * ("Permission server not found: .../api/opencode"). The proxy is mounted at
 * the root now, so the correct server URL is location.origin — force it,
 * overwriting any legacy value.
 */
const SERVER_URL_RESET = `<script id="oc-relay-server-url">
;(() => {
  try {
    // The viewer is bound to exactly one session and one project. Any
    // persisted opencode state from earlier origins/sessions (server URLs,
    // workspace/directory state) poisons the bootstrap — observed as a
    // phantom /api/opencode server and corrupted binary directory params
    // that 500 /api/reference and force /new-session. Wipe ALL opencode.*
    // keys, then point the default server at this origin (root-mounted
    // proxy). The viewer_token lives in an HttpOnly cookie, not localStorage,
    // so this does not log the user out. Drafts and the prompt history are
    // not in localStorage: see draftsReset.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && (k.startsWith('opencode.') || k.startsWith('oc-') || k.startsWith('prefix:'))) {
        localStorage.removeItem(k)
      }
    }
    localStorage.setItem('opencode.settings.dat:defaultServerUrl', location.origin)
  } catch {}
})()
</script>`

/**
 * Guard injected into the UI shell: send a viewer whose access ended back to
 * their share's page.
 *
 * The relay revokes correctly — an expired, evicted or deleted-share token gets
 * its event stream ended on the next heartbeat and 401 on every request — but
 * the web UI has no idea what a 401 means. Its event reader counts one as a
 * failed attempt and retries for as long as the tab lives, backing off to 30 s;
 * a prompt toasts "401 Unauthorized" and stays in the input. The page just sat
 * there, while the one thing that helps (entering the code again) was a page
 * load away: /<session_id> answers the share's code-entry page, or says the
 * share has ended. Nothing in the UI ever made that load.
 *
 * So wrap fetch, which the UI resolves at call time for its API calls and its
 * event stream alike, and on a 401 carrying the relay's own marker (see
 * VIEWER_AUTH_HEADER — a 401 from the owner's opencode has none, and navigating
 * on that would loop) replace the page with /<session_id>. The relay names that
 * id as it serves the shell: the share the page belongs to, known only then.
 * Not read from the path: a subagent's page is served at the subagent's id,
 * and the path the UI has moved to since may name one too, while no share
 * answers a subagent's id — its page would say the share has ended. Not / or
 * /join: a cookie that names no share gets the generic page there, whose code
 * field is disabled. /terminal names nothing; / is all that is left.
 *
 * The response is handed back untouched and its body never read, so the event
 * stream is not disturbed. At most one navigation per tab per AUTH_GUARD_WINDOW_MS
 * (sessionStorage outlives the load): a marked 401 on a page loaded with a
 * working cookie can only mean the cookie changed in between, and bouncing
 * between pages would not help. Classic inline in <head>, so it runs before
 * the UI's deferred module bundle makes its first request.
 */
const AUTH_GUARD_WINDOW_MS = 30_000
/**
 * The share ids /<id> answers (see that route). A share registered under any
 * other id has no such page, so its guard goes to /; the check also keeps what
 * is written into the script inert.
 */
const SHARE_PAGE_ID_RE = /^ses_[A-Za-z0-9_]+$/
const authGuard = (shareId: string | undefined) => `<script id="oc-relay-auth-guard">
;(() => {
  try {
    const original = window.fetch
    if (typeof original !== 'function') return
    const home = ${JSON.stringify(shareId !== undefined && SHARE_PAGE_ID_RE.test(shareId) ? `/${shareId}` : '/')}
    const key = 'oc-relay-auth-redirect-at'
    let left = false
    const leave = () => {
      if (left) return
      const now = Date.now()
      try {
        const last = Number(sessionStorage.getItem(key))
        if (last && now - last >= 0 && now - last < ${AUTH_GUARD_WINDOW_MS}) return
        sessionStorage.setItem(key, String(now))
      } catch {}
      left = true
      location.replace(home)
    }
    window.fetch = function (...args) {
      // Called on window whatever the caller's receiver: native fetch called
      // on any other object throws "Illegal invocation".
      return original.apply(window, args).then((res) => {
        try {
          const marker = res && res.status === 401 ? res.headers.get(${JSON.stringify(VIEWER_AUTH_HEADER)}) : null
          if (marker === ${JSON.stringify(VIEWER_AUTH_INVALID)}) leave()
        } catch {}
        return res
      })
    }
  } catch {}
})()
</script>`

/**
 * Clears the UI's drafts when the browser moves on to a different share.
 *
 * Every share is served from this one origin, and the UI keeps its drafts in
 * IndexedDB ("opencode-drafts", stores documents and blobs), which the
 * localStorage reset above never reached. Unsent drafts there are keyed by
 * session, but the prompt history is kept per browser — one list of the last
 * 100 prompts sent, whatever the session or server. So a prompt sent in one
 * share came back on ArrowUp in the empty input of any share opened later in
 * the same browser, for as long as the browser kept it: past the end of that
 * share and the revocation of its tokens. Upstream
 * opencode web has one owner per origin; the relay puts shares of different
 * owners on one.
 *
 * The share is the one the relay names as it serves the shell, as for
 * authGuard: a subagent's page of the same share keeps the drafts, which are
 * the viewer's own. It is recorded in localStorage under a key the reset above
 * does not remove, once the clear has committed; a reload within the share
 * finds it and changes nothing. /terminal names no share and clears nothing.
 *
 * - Opened without a version, so an existing database is taken as it is. One
 *   that does not exist would be created empty at version 1, and the UI's own
 *   open at version 1 would then never create its stores: that upgrade is
 *   aborted, and there is nothing to clear.
 * - Cleared, not deleted: the UI never closes its connection on versionchange,
 *   so a delete would wait on any other tab still open on this origin, and
 *   this tab's own open would wait behind the delete.
 * - Classic inline in <head>, so its open is queued ahead of the UI's; the
 *   clear transaction is then created first and runs before any read the UI
 *   makes of those stores.
 *
 * A tab of the earlier share still open in the same browser keeps its history
 * in memory and may write it back; only closing it ends that.
 */
const DRAFTS_SHARE_KEY = 'relay-drafts-share'
const draftsReset = (shareId: string) => `<script id="oc-relay-drafts-reset">
;(() => {
  try {
    // "<" escaped so no share id can end this script early.
    const share = ${JSON.stringify(shareId).replace(/</g, '\\u003c')}
    const key = ${JSON.stringify(DRAFTS_SHARE_KEY)}
    if (localStorage.getItem(key) === share) return
    const mark = () => {
      try {
        localStorage.setItem(key, share)
      } catch {}
    }
    const req = indexedDB.open('opencode-drafts')
    // No database yet, so nothing of an earlier share's either. Any other
    // failure leaves the record alone, and the next load tries again.
    let absent = false
    req.onupgradeneeded = () => {
      absent = true
      req.transaction.abort()
    }
    req.onerror = () => {
      if (absent) mark()
    }
    req.onsuccess = () => {
      const db = req.result
      try {
        const stores = ['documents', 'blobs'].filter((name) => db.objectStoreNames.contains(name))
        if (stores.length === 0) {
          db.close()
          return mark()
        }
        const tx = db.transaction(stores, 'readwrite')
        for (const name of stores) tx.objectStore(name).clear()
        tx.oncomplete = () => {
          db.close()
          mark()
        }
        tx.onabort = () => db.close()
      } catch {
        db.close()
      }
    }
  } catch {}
})()
</script>`

/** The UI shell for a page of the share `shareId` (none for /terminal). */
function terminalHtml(shareId?: string): string {
  if (cachedShell === undefined) {
    const html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    const anchor = html.indexOf('</head>')
    cachedShell = anchor === -1 ? { head: html, tail: '' } : { head: html.slice(0, anchor), tail: html.slice(anchor) }
  }
  const drafts = shareId === undefined ? '' : draftsReset(shareId)
  return cachedShell.head + SERVER_URL_RESET + drafts + authGuard(shareId) + cachedShell.tail
}

/**
 * Powerful browser features denied to every relay page and anything it could
 * embed. None of them is called by the UI build (no getUserMedia, geolocation,
 * PaymentRequest, WebAuthn, WebUSB/HID/serial, MIDI or clipboard reads).
 *
 * clipboard-write stays (self), never (): the UI's copy buttons and its
 * terminal call navigator.clipboard.writeText, which Chromium rejects with
 * NotAllowedError under clipboard-write=() — measured in a real browser.
 */
const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'clipboard-read=()',
  'clipboard-write=(self)',
  'display-capture=()',
  'geolocation=()',
  'gyroscope=()',
  'hid=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'publickey-credentials-get=()',
  'screen-wake-lock=()',
  'serial=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ')

/**
 * Content-Security-Policy for the relay's OWN HTML shells only (the UI shell,
 * the join page, the ended page) — not the proxied opencode API and not the
 * SPA bundle, which are served untouched.
 *
 * These shells carry inline <script>s: the upstream index.html's theme preload,
 * the join page's form handler, and the ones the relay injects (SERVER_URL_RESET,
 * authGuard, draftsReset, and join's __OC_SESSION_ID__). Rather than permit all
 * inline script with 'unsafe-inline', cspForShell lists a sha256 hash of every
 * inline <script> actually present in the response, so the header can never
 * drift from what the shell carries, while the upstream SPA bundle still loads
 * from 'self'.
 *
 * Be precise about what that buys. Dropping 'unsafe-inline' blocks inline event
 * handlers (onclick=...), javascript: URLs and eval (only 'wasm-unsafe-eval' is
 * allowed), and 'self' keeps third-party script origins out. It does NOT stop a
 * <script> injected INTO a shell: the hashes are computed over the very bytes
 * being served, so an injected script is hashed along with the rest and allowed.
 * The shells' substitutions must therefore be safe on their own — every one of
 * them is JSON.stringify of a session id constrained to /^ses_[A-Za-z0-9_]+$/,
 * with '<' escaped in draftsReset. Never interpolate unvalidated data into these
 * scripts expecting the CSP to catch it.
 *
 * These other directives are what the upstream opencode SPA needs and no more,
 * measured against its build: 'wasm-unsafe-eval' for its WebAssembly, inline
 * styles (the theme preload builds a <style>; the shells use <style>/style=),
 * blob:/data: for its workers, images and fonts, and same-origin fetch/SSE.
 * object-src, base-uri and frame-ancestors are locked down. Gated behind
 * shellCspEnabled() (RELAY_SHELL_CSP, default OFF) until browser-verified — see
 * that flag and sendShell.
 */
const SHELL_CSP_TAIL = [
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
]

/** Matches every <script ...>...</script> block; group 1 is the attributes. */
const INLINE_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi

/**
 * The CSP for one fully assembled shell. script-src is derived from the
 * response's own bytes: a sha256 hash for each INLINE <script> (one carrying no
 * `src`), so the header can never drift out of sync with the scripts injected —
 * whichever ones a given page happens to carry. External scripts (the SPA
 * bundle, which has `src`) are covered by 'self'.
 */
function cspForShell(html: string): string {
  const hashes: string[] = []
  for (const m of html.matchAll(INLINE_SCRIPT_RE)) {
    if (/\bsrc\s*=/i.test(m[1])) continue
    // The hash is over the element's exact child text — the bytes between the
    // opening tag's '>' and '</script>' — which is what a browser hashes too.
    hashes.push(`'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`)
  }
  const scriptSrc = ["'self'", "'wasm-unsafe-eval'", ...hashes].join(' ')
  return ["default-src 'self'", `script-src ${scriptSrc}`, ...SHELL_CSP_TAIL].join('; ')
}

/**
 * Send one of the relay's own HTML shells, attaching the shell CSP when
 * RELAY_SHELL_CSP is on (see shellCspEnabled). Read lazily per response so the
 * flag can be flipped without a rebuild and so tests can toggle it.
 */
function sendShell(res: express.Response, html: string, status = 200): void {
  if (shellCspEnabled()) res.setHeader('Content-Security-Policy', cspForShell(html))
  res.status(status).type('html').send(html)
}

/**
 * App factory: injects the Store so tests and the entrypoint can share one
 * instance per app. The optional BridgeClient lets the session API disconnect
 * a bridge when its session is deleted (startServer always passes it).
 */
export function createApp(store: Store, bridge?: BridgeClient): Express & { endEventStreams: () => void } {
  const app = express()
  // Ends the viewers' SSE streams on shutdown; nothing to end without the proxy.
  let endEventStreams = () => {}
  // Whether a session id is a subagent of a share (see sessionPage); without
  // the proxy there is nobody to ask.
  let shareAncestry: (share: Session, id: string) => Promise<boolean | undefined> = async () => undefined
  // Which proxy hop to believe for X-Forwarded-For — see trustProxy(). A
  // permissive `true` made XFF fully client-spoofable, defeating per-IP rate
  // limits; a bare 'loopback' inside Docker trusted nothing and collapsed
  // every client into the bridge gateway's address, making the limits global.
  // nginx must set XFF authoritatively (proxy_set_header X-Forwarded-For
  // $proxy_add_x_forwarded_for) — express then takes the right-most address
  // that is not a trusted proxy, so a client-supplied prefix is ignored.
  app.set('trust proxy', trustProxy())
  // No server fingerprint, no MIME sniffing, never framed (the join page takes
  // a secret code — clickjacking protection), and no referrer: the viewer URL
  // carries the session id, which must not leak to third-party origins.
  // Defence in depth on top: no powerful features the UI never uses (see
  // PERMISSIONS_POLICY), no window handle shared with a cross-origin opener or
  // popup, and no bundle or API answer embedded by another site. nginx adds
  // only HSTS, so these must come from here, on every response the relay sends.
  // No Cross-Origin-Embedder-Policy: the UI needs no crossOriginIsolated, and
  // require-corp would only risk blocking any cross-origin image or font.
  app.disable('x-powered-by')
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY)
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    next()
  })
  // Nothing here ever needs an OPTIONS: the web UI is same-origin (no CORS
  // preflight) and the bridge speaks WebSocket. Left to express, EVERY mounted
  // router auto-answers one with 200 + `Allow:`, handing an unauthenticated
  // caller the method table of the public API — OPTIONS /api/sessions returned
  // `Allow: POST`, /api/sessions/<any id> `Allow: GET,HEAD,DELETE`. The proxy
  // adapter grew its own interceptor for this; it only ever covered the proxy
  // router, so the public API kept answering. Refuse it once, app-wide, with
  // the same JSON 404 any unknown method already gets (the adapter's copy is
  // then harmlessly redundant).
  app.use((req, res, next) => {
    if (req.method !== 'OPTIONS') return next()
    res.status(404).json({ error: 'not found' })
  })
  // NO global express.json(): a single parser cannot serve both sides of this
  // app. Its 100 KB default is far too loose for the UNAUTHENTICATED public
  // endpoints (anyone may POST a registration or an activation attempt) and
  // far too tight for the authenticated proxy, where a viewer legitimately
  // pastes a file's worth of text into a prompt. Each side mounts its own
  // parser instead, so nothing is parsed on a route that never reads a body.
  app.use('/health', healthRouter(store))
  // The opencode web UI detects the server API dialect on every page load
  // (detectServerProtocol): it fetches /global/health with a 5 s abort and,
  // only if that is not {healthy:true}, falls back to /api/health. Either
  // answer selects the v1 client, which resolves its requests against the
  // server URL (location.origin), so all UI traffic lands on the root-mounted
  // proxy adapter. BOTH are answered here, never proxied: nearly the whole UI
  // bootstrap (config, providers, projects, the transcript, the event stream)
  // waits for the probe, and a proxied /global/health put all of it behind a
  // round trip over the owner's uplink — up to the full 5 s abort while a
  // bridge re-dials — only to pick the same v1 the fallback picks anyway.
  // Unauthenticated and static: reveals nothing beyond what /health exposes.
  const uiHealth = (_req: express.Request, res: express.Response) => {
    res.json({ healthy: true })
  }
  app.get('/global/health', uiHealth)
  app.get('/api/health', uiHealth)
  // Public, unauthenticated writers: anything a real bridge sends here is a
  // few hundred bytes (session id, directory, title, access code), so cap the
  // body well below express's default rather than letting an anonymous caller
  // make the relay buffer 100 KB per request.
  //
  // Activation answers under ONE spelling: the path nginx's exact-match
  // `location = /api/activate` covers, whose oc_activate zone is the only
  // per-address throttle on code guessing. An express mount ignores case and a
  // trailing slash, and its URL parser turns `\` into `/` once the request line
  // carries a `#`, so /API/activate, /api/activate/ and /api\activate#x all
  // activated while nginx matched none of them and passed them to `location /`
  // under oc_general, a hundred times looser. Any other spelling is now the
  // JSON 404 before its body is read; the join page posts to exactly this one.
  app.use('/api/activate', exactPathOnly('/api/activate'), express.json({ limit: PUBLIC_BODY_LIMIT }), activateRouter(store))
  // The same for the session API, whose oc_register zone nginx applies with
  // the case-sensitive prefix `location /api/sessions`: /API/sessions used to
  // register under oc_general, and on a full relay write a warning per
  // request. It serves /api/sessions/:id too, hence a prefix, not one path.
  app.use('/api/sessions', pathPrefixOnly('/api/sessions'), express.json({ limit: PUBLIC_BODY_LIMIT }), skillRouter(store, bridge))
  /**
   * Send a viewer who lands here back to their own share, if we can tell which
   * one it is.
   *
   * The bare code-entry page is a DEAD END for someone who already has a
   * viewer cookie: it renders with no session id, which disables the input,
   * because a code alone must never be accepted (see joinHtml). So a viewer
   * bounced to the root — by the UI losing its footing, by a stale bookmark,
   * by typing the host name — was shown a form they could not use, while the
   * relay was holding the one thing needed to route them home: their cookie
   * names their session.
   *
   * This grants nothing: the token already authorises exactly this session,
   * and the redirect is the same one /<session_id> performs. Without a usable
   * cookie there is genuinely nothing to route to, and the generic page — with
   * its "open the full link you were given" — is the honest answer.
   */
  const viewerHome = (req: express.Request): string | undefined => {
    const token = cookieViewerToken(req)
    const session = token ? store.getSessionByViewerToken(token) : undefined
    return session ? `/${session.id}` : undefined
  }
  // The root URL is the viewer entry point; the SPA itself lives at /terminal.
  // Registered before static so express.static does not serve index.html here.
  app.get('/', (req, res) => res.redirect(viewerHome(req) ?? '/join'))
  // Content-hashed assets are immutable (see isHashedAsset). setHeaders runs
  // before send writes its own Cache-Control, which it skips when one is set;
  // everything else keeps the default and revalidates.
  const serveStatic = express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
      if (isHashedAsset(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    },
  })
  // Source maps are passed over and end at the JSON 404 (see isSourceMapPath).
  app.use((req, res, next) => (isSourceMapPath(req.path) ? next() : serveStatic(req, res, next)))
  app.get('/join', (req, res) => {
    const home = viewerHome(req)
    if (home) return res.redirect(home)
    return sendShell(res, joinHtml(undefined))
  })
  app.get('/terminal', (_req, res) => sendShell(res, terminalHtml()))
  // Session-bound viewer entry: /<session_id>. Without a valid viewer cookie
  // it serves the code-entry page (with the session id embedded); with one it
  // serves the opencode UI. The :id must look like an opencode session id
  // (ses_...) so single-segment API paths (/config, /agent, /provider, ...)
  // fall through to the root-mounted proxy instead of being captured here.
  // Session-bound viewer entry: /<session_id>. Without a valid viewer cookie
  // it serves the code-entry page (with the session id embedded); with one it
  // REDIRECTS to the real opencode UI session URL, which is
  // /<base64(directory)>/session/<id> — the official UI parses the first
  // segment as base64(directory), so a raw session id here would be decoded
  // into a garbage directory and break the whole bootstrap.
  // NOTE: this and the two routes below use Express 4's inline-regex path
  // syntax ('/:id(ses_...)'), which Express 5 removed (path-to-regexp 6+
  // throws on it). These three routes are what pin the project to express ^4;
  // a v5 upgrade must first rewrite them (e.g. match inside the handler).
  app.get('/:id(ses_[A-Za-z0-9_]+)', (req, res) => {
    const session = store.getSession(req.params.id)
    if (!session) return sendShell(res, endedHtml(), 404)
    const token = cookieViewerToken(req)
    if (token && store.verifyViewer(session.id, token)) {
      // verifyViewer slid the token's idle window: send the cookie again so it
      // slides too, as the proxy does on every API call. Same on the two UI
      // routes below (see setViewerCookie).
      setViewerCookie(res, token)
      return res.redirect(sessionUiUrl(session))
    }
    return sendShell(res, joinHtml(session.id))
  })
  /**
   * A UI session page loaded as a page (a reload, a new tab, a pasted link):
   * /<base64url(directory)>/session/<id> or /server/<base64url(serverUrl)>/session/<id>.
   *
   * A share's own page is served only to an authenticated viewer of THAT
   * share; anyone else is bounced to its code-entry page.
   *
   * Any other id is served the UI too when it is a subagent of the share the
   * cookie names. The UI links a subagent's page — the task card in the
   * transcript — by the subagent's own session id, which no share answers, and
   * leaves a middle- or ctrl-click on that link to the browser. Answered from
   * the share list alone, the viewer's reload of a subagent page, or the tab
   * they opened for it, said "This session has ended" while the share was live.
   *
   * Only a subagent, though. Served for any id, the UI also answered an old
   * link to a share that has since ended (from the browser's history, say) to a
   * viewer who had joined another share: that share's UI under the ended one's
   * URL, where every read collapsed to the live share, showing "session not
   * found" and no composer instead of saying the share ended and how to get a
   * new link. The proof is the proxy's own parent walk (see shareAncestry in
   * proxy/adapter.ts): already known when the viewer came from inside the app,
   * whose reads proved it, and otherwise made once here, where the page's own
   * first read of the subagent would have made it anyway. An id the walk rules
   * out gets the ended page. One it could not finish (the bridge is away,
   * opencode answered an error) gets the UI, as the share's own page does while
   * its bridge is away: nothing shows the share has ended.
   *
   * This grants nothing: the shell is the static UI, and every read it makes
   * goes through the proxy's forced binding, where only a proven descendant of
   * the viewer's share is read as itself (see SUBAGENT_ROUTES). Without a
   * working cookie the answer is the ended page, as before, with nothing asked
   * upstream.
   */
  const sessionPage = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // '/:dir/session/:id' also matches /api/session/<id>, the proxy's /api twin
    // of the session detail, which then answered HTML instead of reaching it.
    if (req.params.dir === 'api') return next()
    const token = cookieViewerToken(req)
    const session = store.getSession(req.params.id)
    if (session) {
      if (token && store.verifyViewer(session.id, token)) {
        // verifyViewer slid the token's idle window: slide the cookie too.
        setViewerCookie(res, token)
        return sendShell(res, terminalHtml(session.id))
      }
      return res.redirect(`/${session.id}`)
    }
    const share = token ? store.getSessionByViewerToken(token) : undefined
    if (!token || !share) return sendShell(res, endedHtml(), 404)
    void shareAncestry(share, req.params.id)
      .then((inShare) => {
        // The walk may have waited out a bridge re-dial: the viewer's access
        // or the share can have ended meanwhile.
        if (inShare === false || store.getSessionByViewerToken(token) !== share) {
          return sendShell(res, endedHtml(), 404)
        }
        setViewerCookie(res, token)
        return sendShell(res, terminalHtml(share.id))
      })
      .catch(next)
  }
  // The official UI session route: /<base64(directory)>/session/<id>.
  app.get('/:dir/session/:id(ses_[A-Za-z0-9_]+)', sessionPage)
  // The UI's SPA route when the viewer navigates/relods inside the app:
  // /server/<base64(serverUrl)>/session/<id>. The server-side must answer the
  // SPA shell for this deep link too, otherwise F5 404s ("Cannot GET
  // /server/.../session/...").
  app.get('/server/:key/session/:id(ses_[A-Za-z0-9_]+)', sessionPage)
  // The proxy adapter mounts at the root LAST. It only routes its own
  // allowlisted opencode paths (/session/..., /agent, /provider, /file, ...);
  // everything else falls through to this 404. Because it is registered after
  // every relay route (/api/*, /join, /terminal, /:id), those keep working.
  if (bridge) {
    const adapter = proxyAdapter(store, bridge)
    app.use(adapter)
    endEventStreams = adapter.endEventStreams
    shareAncestry = adapter.shareAncestry
  }
  // Nothing matched. express's own finalhandler answers an HTML page reading
  // "Cannot PUT /config", which is both the wrong content type for an API and
  // a free framework fingerprint — the relay's own errors are JSON, and so are
  // the client errors mapped below. Reached by an unallowlisted method or path
  // (the allowlist mounts GET /config, so a PUT falls through here), and by a
  // missing asset.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' })
  })
  // A request the relay could not read, answered as JSON and not logged: a
  // body over a parser's limit, one that is not JSON, in a charset or content
  // encoding the parser cannot decode, or gzip that does not inflate, and a
  // path parameter that does not decode. Each arrives here as an error
  // carrying its 4xx status. express's default handler answered an HTML page,
  // which every caller here (the bridge's fetch, the viewer's UI) parses as
  // JSON and reports as an opaque failure, and printed the error's stack
  // unless env is 'test' — NODE_ENV=production does not stop it. That was
  // about 950 bytes a request for any anonymous caller, since the public
  // routes parse before any check, and a SyntaxError's message quotes the raw
  // body around the fault, newlines included: lines of the caller's choosing
  // in the log. So the answer is a fixed string, never err.message.
  // Anything else (a 5xx, or no status: a bug) still goes to express, stack
  // and all.
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const e = err as { type?: unknown; status?: unknown; statusCode?: unknown } | null | undefined
    const status = typeof e?.status === 'number' ? e.status : e?.statusCode
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status >= 500) return next(err)
    if (res.headersSent) return next(err)
    // body-parser's own codes ('entity.too.large' is raw-body's for a limit);
    // anything else by its status alone, as in "bad request".
    const error =
      e?.type === 'entity.too.large'
        ? 'payload too large'
        : e?.type === 'entity.parse.failed'
          ? 'invalid json'
          : e?.type === 'charset.unsupported' || e?.type === 'encoding.unsupported'
            ? 'unsupported media type'
            : (http.STATUS_CODES[status] ?? 'bad request').toLowerCase()
    return res.status(status).json({ error })
  })
  return Object.assign(app, { endEventStreams })
}

/**
 * Body cap for the unauthenticated public API (/api/activate, /api/sessions).
 * Kept local rather than in config.ts: it is a property of these two routes,
 * not a tunable of the relay.
 */
const PUBLIC_BODY_LIMIT = '32kb'

/**
 * Pass a request on only when its request-target, up to any query string, is
 * `path` byte for byte; answer everything else under the mount with the JSON
 * 404 an unknown path gets.
 *
 * Read from the raw originalUrl on purpose, not req.path or req.baseUrl:
 * express's own parsing is what folds case, drops a trailing slash and turns
 * `\` into `/`, so a check on its output would pass the very spellings nginx's
 * exact-match location does not see (nginx proxies the target as the client
 * sent it, in origin form).
 */
function exactPathOnly(path: string): express.RequestHandler {
  return (req, res, next) => {
    if (rawPath(req) === path) return next()
    res.status(404).json({ error: 'not found' })
  }
}

/**
 * exactPathOnly for a mount that also serves paths below it, matched the way
 * nginx matches a prefix location: `prefix` itself or `prefix/...`, byte for
 * byte and case included. Everything else under the mount is the JSON 404.
 */
function pathPrefixOnly(prefix: string): express.RequestHandler {
  return (req, res, next) => {
    const path = rawPath(req)
    if (path === prefix || path.startsWith(`${prefix}/`)) return next()
    res.status(404).json({ error: 'not found' })
  }
}

/** The request-target as the client sent it, up to any query string (see exactPathOnly). */
function rawPath(req: express.Request): string {
  const target = req.originalUrl
  const query = target.indexOf('?')
  return query === -1 ? target : target.slice(0, query)
}

/**
 * The official UI's canonical session URL: /<base64url(directory)>/session/<id>.
 *
 * BASE64URL, unpadded — that is the UI's own spelling, not a stylistic choice.
 * Its encoder is `btoa(x).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')`
 * and its decoder undoes exactly that, so anything else fails to parse and the
 * viewer is dropped on an empty project list ("nothing here yet") with an
 * invalid-directory toast, instead of the session they were invited to.
 *
 * This used to emit standard base64 through encodeURIComponent, which broke in
 * two ways. The padding became %3D%3D and the UI's decoder choked on it — and
 * because padding depends on the directory's length modulo 3, a share worked or
 * failed purely on how long the project path happened to be. A '/' in the
 * base64 alphabet was worse: percent-encoded it still broke the decoder, and
 * unencoded it would split the path segment outright. base64url has neither
 * problem and needs no escaping at all.
 */
function sessionUiUrl(session: { id: string; directory: string }): string {
  return `/${Buffer.from(session.directory, 'utf8').toString('base64url')}/session/${session.id}`
}

let cachedJoinTemplate: string | undefined

/** join.html with the session id injected for the activate call. */
/**
 * Shown when a viewer opens a session the relay does not have: the share was
 * stopped, it aged out, or (before sessions were persisted) the relay had
 * restarted under them. A bare "Session not found" left people guessing, so
 * say what happened and what gets them back in.
 */
function endedHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenCode — Session ended</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
         font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #0d0f12; color: #e6e8eb; padding: 24px; }
  main { max-width: 32rem; text-align: center; }
  h1 { font-size: 1.35rem; margin: 0 0 .6rem; font-weight: 600; }
  p { margin: 0 0 .9rem; color: #a4abb6; }
  code { background: #1a1e24; border-radius: 5px; padding: .15em .45em;
         font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #e6e8eb; }
  @media (prefers-color-scheme: light) {
    body { background: #fbfbfc; color: #14161a; }
    p { color: #5b6472; }
    code { background: #eef0f3; color: #14161a; }
  }
</style>
</head>
<body>
<main>
  <h1>This session has ended</h1>
  <p>The share is no longer active — it was stopped, or it sat idle long enough to be closed.</p>
  <p>Ask whoever shared it to run <code>/remote-control/start</code> again and send you the new link and code.</p>
</main>
</body>
</html>`
}

function joinHtml(sessionId: string | undefined): string {
  if (cachedJoinTemplate === undefined) {
    cachedJoinTemplate = readFileSync(path.join(PUBLIC_DIR, 'join.html'), 'utf8')
  }
  const inject = `<script>window.__OC_SESSION_ID__=${JSON.stringify(sessionId ?? null)}</script>`
  const anchor = cachedJoinTemplate.indexOf('</head>')
  return anchor === -1
    ? cachedJoinTemplate + inject
    : cachedJoinTemplate.slice(0, anchor) + inject + cachedJoinTemplate.slice(anchor)
}

/** viewer_token from the HttpOnly cookie (same parsing as the proxy adapter). */
function cookieViewerToken(req: express.Request): string | undefined {
  const cookie = req.get('cookie')
  if (!cookie) return undefined
  for (const pair of cookie.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq).trim() === 'viewer_token') {
      try {
        return decodeURIComponent(pair.slice(eq + 1).trim())
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/**
 * Full server: HTTP API + WS endpoint for bridges at /bridge + proxy
 * adapter mounted at the root (inside createApp). Returns the listening
 * http.Server.
 */
export async function startServer(port: number = config.port): Promise<http.Server> {
  const store = new Store()
  // Survive a restart: without this, redeploying the relay drops every
  // session and viewer token — viewers get a mid-stream EOF and then 401 on
  // their cookie, with their bridge still running and nothing to reconnect to.
  const persistPath = stateFile()
  const persistence = persistPath ? new FileStateStore(persistPath) : undefined
  if (persistence) {
    const mode = persistence.encrypted ? 'encrypted' : 'PLAINTEXT (no RELAY_STATE_KEY — codes not persisted)'
    console.log(`[relay] session state: ${persistPath} (${mode})`)
    const restored = store.restore(persistence.load())
    // Logged when it is 0 too: a start that restored nothing is exactly the one
    // to see in the log (after a redeploy, every live share just ended).
    console.log(`[relay] restored ${restored} session(s)`)
    store.setChangeListener(() => persistence.schedule(() => store.snapshot()))
  }
  // The bare server is created before the app so the WS bridge (which hooks
  // the server's upgrade event) can be passed into the app factory — the
  // session API needs it to disconnect a bridge when its session is deleted.
  const server = http.createServer()
  const bridge = new BridgeClient(server, store)
  // Every session in the store here was restored from the state file, and its
  // bridge is re-dialling on a backoff that the downtime has stretched to
  // seconds. Viewers reconnecting to this process refetch meanwhile; their
  // GETs must wait for that dial like after any other drop, not fail at once.
  for (const id of store.sessionIds()) bridge.expectReconnect(id)
  const app = createApp(store, bridge)
  server.on('request', app)
  server.on('close', () => bridge.close())
  // Orphan reaper: delete sessions that have been idle too long (bridge died
  // without notice, or a registration never followed through), revoking their
  // codes and tokens. Public registration makes this necessary.
  const reaper = setInterval(() => {
    const removed = store.reapOrphans(config.orphanReapMs)
    for (const id of removed) bridge.disconnect(id)
  }, config.orphanSweepIntervalMs)
  reaper.unref()
  server.on('close', () => clearInterval(reaper))
  // Write the store as it is now, not only what is queued: activity queues a
  // write at most once a minute (see Store.noteActivity), and a bare flush with
  // nothing queued wrote nothing, leaving last_seen/last_used on disk behind
  // the live ones. An empty store with nothing queued has nothing newer to
  // say, so the file is left alone rather than written over one this process
  // could not read (a wrong RELAY_STATE_KEY, say).
  const persistNow = () => {
    if (!persistence) return
    if (store.sessionCount() > 0) persistence.schedule(() => store.snapshot())
    persistence.flush()
  }
  server.on('close', () => {
    if (!persistence) return
    persistNow()
    persistence.close()
    store.setChangeListener(null)
  })
  // Deterministic shutdown flush, independent of the 'close' event: an open
  // viewer SSE stream keeps server.close() pending, so 'close' can be too late
  // (or never fire before SIGKILL). Attach the flush to the server so
  // shutdown() can run it before anything else.
  ;(server as RelayServer).flushState = persistNow
  ;(server as RelayServer).endEventStreams = app.endEventStreams
  await new Promise<void>((resolve) => server.listen(port, resolve))
  return server
}

/** What startServer hangs on its http.Server for shutdown() to use. */
type RelayServer = http.Server & { flushState?: () => void; endEventStreams?: () => void }

/**
 * How long shutdown() lets the viewers' final chunks go out before it drops
 * every connection still open. Kept under the web UI's 250 ms reconnect delay:
 * a browser that sends that reconnect down a kept-alive connection must find
 * it closed, not get a new stream from this process that is then cut. A viewer
 * too backed up to take its final chunk by then is cut, as before.
 */
const SHUTDOWN_GRACE_MS = 150

/**
 * Stop a server from startServer: what the SIGINT/SIGTERM handler runs.
 * Resolves once the server has closed. A connected bridge's WebSocket keeps it
 * open, so the caller still needs its own deadline.
 *
 * This used to drop every connection at once, and the web UI takes a stream
 * whose connection drops as a failed attempt. Its reader keeps counting those
 * for as long as it lives, even across successful reconnects, and waits longer
 * after each one: 3 s, 6 s, 12 s, 24 s, then 30 s. So every redeploy added one
 * for every open tab, plus one for each refused retry while the relay was down,
 * until a tab open through a few deploys went blind for 30 s on a restart that
 * took a second. A stream that ENDS normally is no failure: the UI reconnects
 * 250 ms later with a fresh reader. Hence the order:
 *
 *  1. Persist, before anything can hang.
 *  2. Stop taking connections, so that 250 ms reconnect is refused and retried
 *     against the next process instead of opening a stream on this one.
 *  3. End every viewer stream with its final chunk.
 *  4. After a short grace, drop whatever is still open. An open connection
 *     would keep close() pending, and a stuck one must not hold up a redeploy.
 *
 * What the relay does not control still counts against the tab: a drop on the
 * viewer's own network, a crash, and each retry nginx answers with 502 while
 * no relay is listening. So a restart costs a viewer the backoff a fresh tab
 * would wait out for that much downtime, not a count run up over earlier ones.
 */
export function shutdown(server: http.Server): Promise<void> {
  const relay = server as RelayServer
  relay.flushState?.()
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  relay.endEventStreams?.()
  const cut = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS)
  cut.unref()
  return closed.finally(() => clearTimeout(cut))
}
