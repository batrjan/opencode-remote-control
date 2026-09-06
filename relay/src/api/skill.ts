import express from 'express'
import type { Store } from '../store.js'
import type { BridgeClient } from '../ws/bridge.js'

/**
 * Session-management API used by the bridge client (spawned by the OpenCode
 * skill), hence "skill router". Mounted at /api/sessions.
 *
 * PUBLIC by design (works out of the box, no shared key):
 * - POST   /api/sessions        — public registration, rate-limited per IP
 * - GET    /api/sessions/:id    — non-secret status view (bridge status cmd)
 * - DELETE /api/sessions/:id    — requires the session's OWN bridge_token in
 *                                 the `x-bridge-token` header, so only the
 *                                 session owner (the bridge that registered
 *                                 it) can kill it — never another user.
 *
 * The optional BridgeClient disconnects the session's bridge on DELETE.
 */
export function skillRouter(store: Store, bridge?: BridgeClient) {
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
    const ip = req.ip ?? 'unknown'
    try {
      store.checkRegistrationLimit(ip)
    } catch {
      return res.status(429).json({ error: 'rate limited' })
    }
    try {
      const result = store.createSession(
        session_id,
        directory,
        typeof title === 'string' ? title : '',
        ip,
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
      viewer_count: session.viewers.size,
      bridge_connected: bridge?.isConnected(session.id) ?? false,
    })
  })

  router.delete('/:id', (req, res) => {
    const token = req.get('x-bridge-token') ?? ''
    if (!token || !store.verifyBridgeToken(req.params.id, token)) {
      // Same shape as "not found" — do not reveal whether the session exists.
      return res.status(404).json({ error: 'session not found' })
    }
    if (!store.deleteSession(req.params.id)) {
      return res.status(404).json({ error: 'session not found' })
    }
    // Disconnect the session's bridge and fail its pending proxy requests;
    // otherwise the socket would linger (and could serve a future session
    // that reuses the id).
    bridge?.disconnect(req.params.id)
    return res.status(204).end()
  })

  return router
}
