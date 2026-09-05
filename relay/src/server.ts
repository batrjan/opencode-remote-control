import express from 'express'
import type { Express } from 'express'
import { Store } from './store'
import { activateRouter } from './api/activate'
import { skillRouter } from './api/skill'

/**
 * App factory: injects the Store so tests and the entrypoint can share one
 * instance per app.
 */
export function createApp(store: Store): Express {
  const app = express()
  app.use(express.json())
  app.get('/health', (_req, res) => {
    res.json({ ok: true, sessions: store.sessionCount() })
  })
  app.use('/api/activate', activateRouter(store))
  app.use('/api/sessions', skillRouter(store))
  return app
}
