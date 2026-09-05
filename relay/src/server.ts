import express from 'express'
import type { Express } from 'express'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store'
import { activateRouter } from './api/activate'
import { skillRouter } from './api/skill'
import { BridgeClient } from './ws/bridge'
import { proxyAdapter } from './proxy/adapter'
import { config } from './config'

/**
 * Static viewer UI (opencode web dist + join page). Resolved relative to this
 * module so it works both from src/ (vitest) and dist/ (compiled): in both
 * cases the public dir is a sibling of the module's parent.
 */
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url))

/**
 * App factory: injects the Store so tests and the entrypoint can share one
 * instance per app.
 */
export function createApp(store: Store): Express {
  const app = express()
  app.set('trust proxy', true)
  app.use(express.json())
  app.get('/health', (_req, res) => {
    res.json({ ok: true, sessions: store.sessionCount() })
  })
  app.use('/api/activate', activateRouter(store))
  app.use('/api/sessions', skillRouter(store))
  // The root URL is the viewer entry point; the SPA itself lives at /terminal.
  // Registered before static so express.static does not serve index.html here.
  app.get('/', (_req, res) => res.redirect('/join'))
  app.use(express.static(PUBLIC_DIR))
  app.get('/join', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'join.html')))
  app.get('/terminal', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')))
  return app
}

/**
 * Full server: HTTP API + WS endpoint for bridges at /bridge + proxy
 * adapter at /api/opencode. Returns the listening http.Server.
 */
export async function startServer(port: number = config.port): Promise<http.Server> {
  const store = new Store()
  const app = createApp(store)
  const server = http.createServer(app)
  const bridge = new BridgeClient(server, store)
  app.use('/api/opencode', proxyAdapter(store, bridge))
  server.on('close', () => bridge.close())
  await new Promise<void>((resolve) => server.listen(port, resolve))
  return server
}
