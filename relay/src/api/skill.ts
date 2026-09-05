import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { timingSafeEqual } from 'node:crypto'
import type { Store } from '../store.js'
import { relayApiKey } from '../config.js'

/**
 * Session-management API used by the bridge client (spawned by the OpenCode
 * skill), hence "skill router". Mounted at /api/sessions.
 *
 * Every route requires the shared relay secret in the `x-api-key` header
 * (RELAY_API_KEY env). The comparison is constant-time; a missing key fails
 * closed (401 for every request).
 */
export function skillRouter(store: Store) {
  const router = express.Router()

  router.use(requireApiKey)

  router.post('/', (req, res) => {
    const body = req.body ?? {}
    const { session_id, directory, title } = body
    if (typeof session_id !== 'string' || session_id.length === 0) {
      return res.status(400).json({ error: 'session_id is required' })
    }
    if (typeof directory !== 'string' || directory.length === 0) {
      return res.status(400).json({ error: 'directory is required' })
    }
    try {
      const result = store.createSession(
        session_id,
        directory,
        typeof title === 'string' ? title : '',
      )
      return res.status(201).json(result)
    } catch (err) {
      if (err instanceof Error && err.message === 'session exists') {
        return res.status(409).json({ error: 'session exists' })
      }
      throw err
    }
  })

  /** Non-secret status view for `bridge status`. */
  router.get('/:id', (req, res) => {
    const session = store.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: 'session not found' })
    return res.json({
      session_id: session.id,
      directory: session.directory,
      title: session.title,
      status: session.status,
      created_at: session.created_at,
      last_seen: session.last_seen,
    })
  })

  router.delete('/:id', (req, res) => {
    if (!store.deleteSession(req.params.id)) {
      return res.status(404).json({ error: 'session not found' })
    }
    return res.status(204).end()
  })

  return router
}

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const expected = relayApiKey()
  const provided = req.get('x-api-key') ?? ''
  if (!expected || !safeEqual(provided, expected)) {
    return res.status(401).json({ error: 'invalid api key' })
  }
  next()
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}
