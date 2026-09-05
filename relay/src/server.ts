import express from 'express'
import type { Express } from 'express'
import http from 'node:http'
import { Store } from './store'
import { activateRouter } from './api/activate'
import { skillRouter } from './api/skill'
import { BridgeClient } from './ws/bridge'
import { proxyAdapter } from './proxy/adapter'
import { config } from './config'

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
