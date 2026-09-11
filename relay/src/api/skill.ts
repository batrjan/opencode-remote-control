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
/** Upper bounds for public registration fields (bytes of UTF-16 units). */
const MAX_SESSION_ID = 128
const MAX_DIRECTORY = 4096
const MAX_TITLE = 1024

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
    // Registration is public: bound what one request may lodge in memory and
    // in the persisted state file. Real ids/paths/titles are far shorter.
    if (session_id.length > MAX_SESSION_ID || directory.length > MAX_DIRECTORY) {
      return res.status(400).json({ error: 'field too long' })
    }
    if (typeof title === 'string' && title.length > MAX_TITLE) {
      return res.status(400).json({ error: 'field too long' })
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
      // Consume the registration slot only now that a session really exists:
      // checking used to increment, so a request that ended in 409 below (a
      // duplicate id — a bridge retrying its own registration, typically) burned
      // an hour of the caller's quota while creating nothing.
      store.commitRegistration(ip)
      return res.status(201).json(result)
    } catch (err) {
      if (err instanceof Error && err.message === 'session exists') {
        return res.status(409).json({ error: 'session exists' })
      }
      throw err
    }
  })

  /**
   * Presence view. A session id is not a secret (it is in the share URL), so
   * this endpoint is public — but the session's `directory` (an absolute host
   * path) and `title` are private, and were disclosed to anyone holding the id.
   * They are returned ONLY to the bridge that owns the session (its
   * bridge_token), which is what `bridge status` presents; everyone else gets
   * pure presence.
   */
  router.get('/:id', (req, res) => {
    const session = store.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: 'session not found' })
    const owner = store.verifyBridgeToken(session.id, req.get('x-bridge-token') ?? '')
    return res.json({
      session_id: session.id,
      status: session.status,
      created_at: session.created_at,
      last_seen: session.last_seen,
      viewer_count: session.viewers.size,
      bridge_connected: bridge?.isConnected(session.id) ?? false,
      ...(owner ? { directory: session.directory, title: session.title } : {}),
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
