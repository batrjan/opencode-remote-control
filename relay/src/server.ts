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
import { config } from './config.js'

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
  // Trust only loopback proxies (nginx on the same host). A permissive
  // `true` made X-Forwarded-For fully client-spoofable, defeating per-IP
  // rate limits. nginx must set XFF authoritatively (proxy_set_header
  // X-Forwarded-For $proxy_add_x_forwarded_for).
  app.set('trust proxy', 'loopback')
  app.use(express.json())
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
  app.use('/api/activate', activateRouter(store))
  app.use('/api/sessions', skillRouter(store, bridge))
  // The root URL is the viewer entry point; the SPA itself lives at /terminal.
  // Registered before static so express.static does not serve index.html here.
  app.get('/', (_req, res) => res.redirect('/join'))
  app.use(express.static(PUBLIC_DIR))
  app.get('/join', (_req, res) => res.type('html').send(joinHtml(undefined)))
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
  app.get('/:id(ses_[A-Za-z0-9]+)', (req, res) => {
    const session = store.getSession(req.params.id)
    if (!session) return res.status(404).type('html').send('<h1>Session not found</h1>')
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
  app.get('/:dir/session/:id(ses_[A-Za-z0-9]+)', (req, res) => {
    const session = store.getSession(req.params.id)
    if (!session) return res.status(404).type('html').send('<h1>Session not found</h1>')
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
  return app
}

/** The official UI's canonical session URL: /<base64(directory)>/session/<id>. */
function sessionUiUrl(session: { id: string; directory: string }): string {
  const dir = Buffer.from(session.directory, 'utf8').toString('base64')
  return `/${encodeURIComponent(dir)}/session/${session.id}`
}

let cachedJoinTemplate: string | undefined

/** join.html with the session id injected for the activate call. */
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
  // The bare server is created before the app so the WS bridge (which hooks
  // the server's upgrade event) can be passed into the app factory — the
  // session API needs it to disconnect a bridge when its session is deleted.
  const server = http.createServer()
  const bridge = new BridgeClient(server, store)
  const app = createApp(store, bridge)
  server.on('request', app)
  server.on('close', () => bridge.close())
  await new Promise<void>((resolve) => server.listen(port, resolve))
  return server
}
