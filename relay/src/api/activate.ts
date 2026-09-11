import express from 'express'
import type { Store } from '../store.js'
import { activateFailDelayMs, config } from '../config.js'

/**
 * POST /api/activate — exchange an access code for a viewer token.
 * Same error body for unknown/blocked codes; 429 only on per-IP limits.
 * Failed attempts are delayed (activateFailDelayMs, 1s by default) as a
 * brute-force brake; the delay is disabled in tests via the env flag.
 */
export function activateRouter(store: Store) {
  const router = express.Router()
  router.post('/', async (req, res) => {
    const { code, session_id: sessionId } = req.body ?? {}
    if (typeof code !== 'string' || code.length === 0) {
      return res.status(400).json({ error: 'invalid code' })
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return res.status(400).json({ error: 'invalid code' })
    }
    // trust proxy is enabled in server.ts, so req.ip is the real client IP
    // (first X-Forwarded-For hop) rather than the nginx peer.
    const ip = req.ip ?? 'unknown'
    try {
      const { session_id, viewer_token } = store.activate(code, sessionId, ip)
      res.cookie('viewer_token', viewer_token, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        // Without maxAge this was a browser-session cookie: it died on browser
        // restart while the token stayed valid server-side, so the viewer was
        // bounced back to the join page for no reason. Match the store's viewer
        // idle window instead — the next activation issues a fresh cookie, so
        // the two expire together.
        maxAge: config.viewerIdleTtlMs,
        // Explicit: the token is used on /session/* and /api/* alike, so it must
        // not inherit a path from wherever /api/activate happens to be mounted.
        path: '/',
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
