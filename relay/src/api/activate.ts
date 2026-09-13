import express from 'express'
import type { Store } from '../store.js'
import { activateFailDelayMs } from '../config.js'
import { MAX_SESSION_ID } from './skill.js'
import { setViewerCookie } from './viewerCookie.js'

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
    // A wrong guess is recorded against the session it names, keyed by the raw
    // id (store.activate's per-session failure lock) — so an unbounded id let
    // an anonymous caller pin ~32 KB of heap per request (the public body cap)
    // by naming a different made-up session each time, up to the tracking
    // maps' 100k-entry cap: gigabytes. Registration refuses ids past this
    // bound, so no session that could ever be activated has one; refuse it
    // before anything is remembered, with the same answer as any bad attempt.
    if (sessionId.length > MAX_SESSION_ID) {
      return res.status(400).json({ error: 'invalid code' })
    }
    // Kept for the log line only: activation itself is no longer throttled per
    // address (see config.ts) — the brake is the per-session consecutive-failure
    // lock. `trust proxy` still matters for registration, which does key on it.
    const ip = req.ip ?? 'unknown'
    try {
      const { session_id, viewer_token } = store.activate(code, sessionId)
      // The first of many: every response that authenticates this viewer by
      // the cookie sends it again, so it slides with the token (see
      // setViewerCookie).
      setViewerCookie(res, viewer_token)
      return res.json({ session_id, viewer_token })
    } catch (err) {
      if (err instanceof Error && err.message === 'rate limited') {
        console.warn(`[activate] rate limited ip=${ip}`)
        return res.status(429).json({ error: 'rate limited' })
      }
      // Distinct from every other rejection, and safe to be distinct: this one
      // is only ever reached AFTER the code matched, so it tells an attacker
      // nothing they did not already know. Telling the caller the share is
      // full — rather than "invalid code" — is the difference between a person
      // retrying a code that is fine and a person asking the owner for a seat.
      if (err instanceof Error && err.message === 'session full') {
        console.warn(`[activate] session at viewer capacity ip=${ip}`)
        return res.status(429).json({ error: 'session full' })
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
