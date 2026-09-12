import express from 'express'
import type { Express } from 'express'
import http from 'node:http'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'
import { activateRouter } from './api/activate.js'
import { healthRouter } from './api/health.js'
import { skillRouter } from './api/skill.js'
import { BridgeClient } from './ws/bridge.js'
import { proxyAdapter } from './proxy/adapter.js'
import { config, stateFile, trustProxy } from './config.js'
import { FileStateStore } from './persist.js'

/**
 * Static viewer UI (opencode web dist + join page). Resolved relative to this
 * module so it works both from src/ (vitest) and dist/ (compiled): in both
 * cases the public dir is a sibling of the module's parent.
 */
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url))

let cachedTerminalHtml: string | undefined

/**
 * The official UI's index.html. The proxy adapter is mounted at the server
 * ROOT (see startServer), so the UI's default server URL is location.origin
 * — exactly how the real opencode web behaves when served by its own server.
 * No bootstrap/localStorage seeding is needed: absolute API paths
 * (/provider, /global/health, /session/...) all land on the root proxy.
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
    // workspace/directory state, drafts) poisons the bootstrap — observed as
    // a phantom /api/opencode server and corrupted binary directory params
    // that 500 /api/reference and force /new-session. Wipe ALL opencode.*
    // keys, then point the default server at this origin (root-mounted
    // proxy). The viewer_token lives in an HttpOnly cookie, not localStorage,
    // so this does not log the user out.
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

function terminalHtml(): string {
  if (cachedTerminalHtml === undefined) {
    const html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    const anchor = html.indexOf('</head>')
    cachedTerminalHtml =
      anchor === -1 ? html + SERVER_URL_RESET : html.slice(0, anchor) + SERVER_URL_RESET + html.slice(anchor)
  }
  return cachedTerminalHtml
}

/**
 * App factory: injects the Store so tests and the entrypoint can share one
 * instance per app. The optional BridgeClient lets the session API disconnect
 * a bridge when its session is deleted (startServer always passes it).
 */
export function createApp(store: Store, bridge?: BridgeClient): Express {
  const app = express()
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
  app.disable('x-powered-by')
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    next()
  })
  // NO global express.json(): a single parser cannot serve both sides of this
  // app. Its 100 KB default is far too loose for the UNAUTHENTICATED public
  // endpoints (anyone may POST a registration or an activation attempt) and
  // far too tight for the authenticated proxy, where a viewer legitimately
  // pastes a file's worth of text into a prompt. Each side mounts its own
  // parser instead, so nothing is parsed on a route that never reads a body.
  app.use('/health', healthRouter(store))
  // The opencode web UI probes /api/health to detect the server API dialect.
  // Answering {healthy:true} selects the v1 client, which prefixes every
  // request with the configured server URL — the viewer bootstrap points that
  // at /api/opencode, so all UI traffic flows through the proxy adapter.
  // (The v2 dialect builds URLs with new URL('/api/...', base) and would
  // escape the prefix.) Unauthenticated and static: reveals nothing beyond
  // what /health already exposes.
  app.get('/api/health', (_req, res) => {
    res.json({ healthy: true })
  })
  // Public, unauthenticated writers: anything a real bridge sends here is a
  // few hundred bytes (session id, directory, title, access code), so cap the
  // body well below express's default rather than letting an anonymous caller
  // make the relay buffer 100 KB per request.
  app.use('/api/activate', express.json({ limit: PUBLIC_BODY_LIMIT }), activateRouter(store))
  app.use('/api/sessions', express.json({ limit: PUBLIC_BODY_LIMIT }), skillRouter(store, bridge))
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
  app.use(express.static(PUBLIC_DIR))
  app.get('/join', (req, res) => {
    const home = viewerHome(req)
    if (home) return res.redirect(home)
    return res.type('html').send(joinHtml(undefined))
  })
  app.get('/terminal', (_req, res) => res.type('html').send(terminalHtml()))
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
    if (!session) return res.status(404).type('html').send(endedHtml())
    const token = cookieViewerToken(req)
    if (token && store.verifyViewer(session.id, token)) {
      return res.redirect(sessionUiUrl(session))
    }
    return res.type('html').send(joinHtml(session.id))
  })
  // The official UI session route: /<base64(directory)>/session/<id>. Serve
  // the UI only to an authenticated viewer of THAT session; otherwise bounce
  // to the session's code-entry page. The :dir segment is base64url of the
  // session directory — we validate by decoding and comparing to the session.
  app.get('/:dir/session/:id(ses_[A-Za-z0-9_]+)', (req, res) => {
    const session = store.getSession(req.params.id)
    if (!session) return res.status(404).type('html').send(endedHtml())
    const token = cookieViewerToken(req)
    if (token && store.verifyViewer(session.id, token)) {
      return res.type('html').send(terminalHtml())
    }
    return res.redirect(`/${session.id}`)
  })
  // The UI's SPA route when the viewer navigates/relods inside the app:
  // /server/<base64(serverUrl)>/session/<id>. Same auth rule as above — the
  // server-side must answer the SPA shell for this deep link, otherwise F5
  // 404s ("Cannot GET /server/.../session/...").
  app.get('/server/:key/session/:id(ses_[A-Za-z0-9_]+)', (req, res) => {
    const session = store.getSession(req.params.id)
    if (!session) return res.status(404).type('html').send(endedHtml())
    const token = cookieViewerToken(req)
    if (token && store.verifyViewer(session.id, token)) {
      return res.type('html').send(terminalHtml())
    }
    return res.redirect(`/${session.id}`)
  })
  // The proxy adapter mounts at the root LAST. It only routes its own
  // allowlisted opencode paths (/session/..., /agent, /provider, /file, ...);
  // everything else falls through to this 404. Because it is registered after
  // every relay route (/api/*, /join, /terminal, /:id), those keep working.
  if (bridge) app.use(proxyAdapter(store, bridge))
  // Nothing matched. express's own finalhandler answers an HTML page reading
  // "Cannot PUT /config", which is both the wrong content type for an API and
  // a free framework fingerprint — every other error this relay produces is
  // JSON. Reached by an unallowlisted method or path (the allowlist mounts
  // GET /config, so a PUT falls through here), and by a missing asset.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' })
  })
  // Body-size failures as JSON. express's default handler answers an HTML
  // error page, which every caller here (the bridge's fetch, the viewer's UI)
  // parses as JSON and reports as an opaque failure instead of "too large".
  // 'entity.too.large' is raw-body's code for exceeding a parser's limit.
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if ((err as { type?: unknown } | null)?.type !== 'entity.too.large') return next(err)
    if (res.headersSent) return next(err)
    return res.status(413).json({ error: 'payload too large' })
  })
  return app
}

/**
 * Body cap for the unauthenticated public API (/api/activate, /api/sessions).
 * Kept local rather than in config.ts: it is a property of these two routes,
 * not a tunable of the relay.
 */
const PUBLIC_BODY_LIMIT = '32kb'

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
    const restored = store.restore(persistence.load())
    const mode = persistence.encrypted ? 'encrypted' : 'PLAINTEXT (no RELAY_STATE_KEY — codes not persisted)'
    console.log(`[relay] session state: ${persistPath} (${mode})`)
    if (restored) console.log(`[relay] restored ${restored} session(s)`)
    store.setChangeListener(() => persistence.schedule(() => store.snapshot()))
  }
  // The bare server is created before the app so the WS bridge (which hooks
  // the server's upgrade event) can be passed into the app factory — the
  // session API needs it to disconnect a bridge when its session is deleted.
  const server = http.createServer()
  const bridge = new BridgeClient(server, store)
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
  server.on('close', () => {
    if (!persistence) return
    // Write whatever is still queued before the process goes away.
    persistence.flush()
    persistence.close()
    store.setChangeListener(null)
  })
  // Deterministic shutdown flush, independent of the 'close' event: an open
  // viewer SSE stream keeps server.close() pending, so 'close' can be too late
  // (or never fire before SIGKILL). Attach the flush to the server so the
  // signal handler can run it directly and then force connections closed.
  ;(server as http.Server & { flushState?: () => void }).flushState = () => {
    if (!persistence) return
    persistence.flush()
  }
  await new Promise<void>((resolve) => server.listen(port, resolve))
  return server
}
