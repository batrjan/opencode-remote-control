import express from 'express'
import type { Store } from '../store'
import { activateFailDelayMs } from '../config'

/**
 * POST /api/activate — exchange an access code for a viewer token.
 * Same error body for unknown/blocked codes; 429 only on per-IP limits.
 * Failed attempts are delayed (activateFailDelayMs, 1s by default) as a
 * brute-force brake; the delay is disabled in tests via the env flag.
 */
export function activateRouter(store: Store) {
  const router = express.Router()
  router.post('/', async (req, res) => {
    const code = (req.body ?? {}).code
    if (typeof code !== 'string' || code.length === 0) {
      return res.status(400).json({ error: 'invalid code' })
    }
    // trust proxy is enabled in server.ts, so req.ip is the real client IP
    // (first X-Forwarded-For hop) rather than the nginx peer.
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
        console.warn(`[activate] rate limited ip=${ip}`)
        return res.status(429).json({ error: 'rate limited' })
      }
      // Never log the attempted code (could be a typo'd real one); the IP is
      // the signal needed for abuse monitoring.
      console.warn(`[activate] rejected code attempt from ip=${ip}`)
      await delay(activateFailDelayMs())
      return res.status(400).json({ error: 'invalid code' })
    }
  })
  return router
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
