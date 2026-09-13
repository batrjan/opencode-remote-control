import express from 'express'
import type { Express } from 'express'
import http from 'node:http'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'
import { activateRouter } from './api/activate.js'
import { setViewerCookie } from './api/viewerCookie.js'
import { healthRouter } from './api/health.js'
import { skillRouter } from './api/skill.js'
import { BridgeClient } from './ws/bridge.js'
import { proxyAdapter, VIEWER_AUTH_HEADER, VIEWER_AUTH_INVALID } from './proxy/adapter.js'
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
 * on that would loop) replace the page with /<session_id>. That id comes from
 * the path this shell was served at: the relay serves it only at URLs naming
 * the share (/<dir>/session/<id>, /server/<key>/session/<id>), while the path
 * the UI has moved to since may name another session, a subagent's, which no
 * share answers. Not / or /join: a cookie that names no share gets the generic
 * page there, whose code field is disabled. /terminal names nothing; / is all
 * that is left.
 *
 * The response is handed back untouched and its body never read, so the event
 * stream is not disturbed. At most one navigation per tab per AUTH_GUARD_WINDOW_MS
 * (sessionStorage outlives the load): a marked 401 on a page loaded with a
 * working cookie can only mean the cookie changed in between, and bouncing
 * between pages would not help. Classic inline in <head>, so it runs before
 * the UI's deferred module bundle makes its first request.
 */
const AUTH_GUARD_WINDOW_MS = 30_000
const AUTH_GUARD = `<script id="oc-relay-auth-guard">
;(() => {
  try {
    const original = window.fetch
    if (typeof original !== 'function') return
    const share = /\\/session\\/(ses_[A-Za-z0-9_]+)/.exec(location.pathname)
    const home = share ? '/' + share[1] : '/'
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

function terminalHtml(): string {
  if (cachedTerminalHtml === undefined) {
    const html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    const anchor = html.indexOf('</head>')
    const inject = SERVER_URL_RESET + AUTH_GUARD
    cachedTerminalHtml = anchor === -1 ? html + inject : html.slice(0, anchor) + inject + html.slice(anchor)
  }
  return cachedTerminalHtml
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
      // verifyViewer slid the token's idle window: send the cookie again so it
      // slides too, as the proxy does on every API call. Same on the two UI
      // routes below (see setViewerCookie).
      setViewerCookie(res, token)
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
      setViewerCookie(res, token)
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
      setViewerCookie(res, token)
      return res.type('html').send(terminalHtml())
    }
    return res.redirect(`/${session.id}`)
  })
  // The proxy adapter mounts at the root LAST. It only routes its own
  // allowlisted opencode paths (/session/..., /agent, /provider, /file, ...);
  // everything else falls through to this 404. Because it is registered after
  // every relay route (/api/*, /join, /terminal, /:id), those keep working.
  if (bridge) {
    const adapter = proxyAdapter(store, bridge)
    app.use(adapter)
    endEventStreams = adapter.endEventStreams
  }
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
  return Object.assign(app, { endEventStreams })
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
