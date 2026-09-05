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

/**
 * Bootstrap injected into the viewer UI (/terminal) at serve time. The
 * opencode web app reads its default server URL from this localStorage key;
 * unseeded it falls back to location.origin and every API call misses the
 * /api/opencode proxy (404). Injecting at serve time covers both Dockerfile
 * UI sources (prebuilt and source-built) with a single implementation.
 */
const VIEWER_BOOTSTRAP = `<script id="oc-relay-bootstrap">
;(function () {
  localStorage.setItem(
    'opencode.settings.dat:defaultServerUrl',
    location.origin + '/api/opencode',
  )
})()
</script>`

let cachedTerminalHtml: string | undefined

/** The UI's index.html with VIEWER_BOOTSTRAP injected before </head>. */
function terminalHtml(): string {
  if (cachedTerminalHtml === undefined) {
    const html = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    const anchor = html.indexOf('</head>')
    cachedTerminalHtml =
      anchor === -1 ? html + VIEWER_BOOTSTRAP : html.slice(0, anchor) + VIEWER_BOOTSTRAP + html.slice(anchor)
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
  app.get('/join', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'join.html')))
  app.get('/terminal', (_req, res) => res.type('html').send(terminalHtml()))
  return app
}

/**
 * Full server: HTTP API + WS endpoint for bridges at /bridge + proxy
 * adapter at /api/opencode. Returns the listening http.Server.
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
  app.use('/api/opencode', proxyAdapter(store, bridge))
  server.on('close', () => bridge.close())
  await new Promise<void>((resolve) => server.listen(port, resolve))
  return server
}
