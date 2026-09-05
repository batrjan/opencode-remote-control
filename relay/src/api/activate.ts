import express from 'express'
import type { Store } from '../store'

/**
 * POST /api/activate — exchange an access code for a viewer token.
 * Same error body for unknown/blocked codes; 429 only on per-IP limits.
 */
export function activateRouter(store: Store) {
  const router = express.Router()
  router.post('/', (req, res) => {
    const code = (req.body ?? {}).code
    if (typeof code !== 'string' || code.length === 0) {
      return res.status(400).json({ error: 'invalid code' })
    }
    const ip = req.ip ?? 'unknown'
    try {
      const { session_id, viewer_token } = store.activate(code, ip)
      res.cookie('viewer_token', viewer_token, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
      })
      return res.json({ session_id, viewer_token })
    } catch (err) {
      if (err instanceof Error && err.message === 'rate limited') {
        return res.status(429).json({ error: 'rate limited' })
      }
      return res.status(400).json({ error: 'invalid code' })
    }
  })
  return router
}
