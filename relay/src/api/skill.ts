import express from 'express'
import type { Store } from '../store'

/**
 * Session-management API used by the bridge client (spawned by the OpenCode
 * skill), hence "skill router". Mounted at /api/sessions.
 */
export function skillRouter(store: Store) {
  const router = express.Router()

  router.post('/', (req, res) => {
    const body = req.body ?? {}
    const { session_id, directory, title } = body
    if (typeof session_id !== 'string' || session_id.length === 0) {
      return res.status(400).json({ error: 'session_id is required' })
    }
    if (typeof directory !== 'string' || directory.length === 0) {
      return res.status(400).json({ error: 'directory is required' })
    }
    const result = store.createSession(
      session_id,
      directory,
      typeof title === 'string' ? title : '',
    )
    return res.status(201).json(result)
  })

  return router
}
