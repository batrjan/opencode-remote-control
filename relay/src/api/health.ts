import express from 'express'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Store } from '../store.js'

/**
 * Relay version, read from package.json at module load. The path resolves
 * the same from src/ (vitest) and dist/ (compiled): package.json is two
 * levels up from this module in both layouts, and the Docker image ships it
 * next to dist/. Falls back to 'unknown' rather than breaking liveness.
 */
function relayVersion(): string {
  try {
    const pkg: unknown = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    )
    if (typeof pkg === 'object' && pkg !== null && 'version' in pkg) {
      const { version } = pkg
      if (typeof version === 'string') return version
    }
  } catch {
    // fall through to 'unknown'
  }
  return 'unknown'
}

const VERSION = relayVersion()

/**
 * Liveness probe: unauthenticated, static shape, safe to expose — it reveals
 * nothing beyond a session count and the software version. Consumed by the
 * Docker HEALTHCHECK, the compose healthcheck and `bridge status` (all check
 * the HTTP status only), and by uptime monitors that can read the body.
 *
 * Body: { ok, healthy, sessions, version } — `ok`/`healthy` are kept as
 * aliases because probes written against either convention exist.
 */
export const healthRouter = (store: Store) => {
  const r = express.Router()
  r.get('/', (_req, res) => {
    res.json({ ok: true, healthy: true, sessions: store.sessionCount(), version: VERSION })
  })
  return r
}
