import express, { type Request } from 'express'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Store } from '../store.js'
import { faults } from '../faults.js'
import { droppedGlobalEvents } from '../proxy/event-drops.js'

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
 * Every address a request can arrive FROM without having crossed the edge: the
 * container's own loopback (the image's HEALTHCHECK) and the private ranges the
 * docker bridge hands out (the host reaching the published port, which is
 * published on 127.0.0.1 only).
 */
const LOCAL_PEER =
  /^(?:::1|::ffff:(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|f[cd])/i

/**
 * Did this request reach the relay without passing the public edge?
 *
 * Read from the hop itself rather than from `req.ip`: the forwarded header is
 * what nginx APPENDS the real client to (`$proxy_add_x_forwarded_for`), so its
 * presence marks a request that came through the edge whatever it claims to be,
 * and its absence is not something a public client can arrange — nginx adds the
 * header to everything it proxies. Deliberately not `req.ip`, which would make
 * this depend on RELAY_TRUST_PROXY being right: with the old hard-coded
 * `loopback` (see DEPLOY.md) every client collapses into the bridge gateway,
 * which is precisely a private address.
 */
function fromOperatorSide(req: Request): boolean {
  if (req.get('x-forwarded-for') !== undefined || req.get('forwarded') !== undefined) return false
  return LOCAL_PEER.test(req.socket.remoteAddress ?? '')
}

/**
 * Liveness probe: unauthenticated and static in shape — to an anonymous caller
 * it reveals nothing beyond a session count and the software version. Consumed
 * by the Docker HEALTHCHECK, the compose healthcheck and `bridge status` (all
 * check the HTTP status only), and by uptime monitors that can read the body.
 *
 * Body: { ok, healthy, sessions, version } — `ok`/`healthy` are kept as aliases
 * because probes written against either convention exist — plus, for a caller
 * on the operator's side (see fromOperatorSide), `faults`, which counts the
 * errors the process survived (see faults.ts), `claims`, which says whether
 * ended shares' ids are still being reserved for the installs that shared them
 * (Store.claimStats: a `refused` that moves means the map is full and they are
 * not), and `events_dropped`, the opencode event kinds the viewer filter is
 * withholding because they carry no session id and are not on its allow-list
 * (see proxy/event-drops.ts — it is what turns "that panel never updates" from
 * a week of browser debugging into one read). None of the three is public:
 * `events_dropped` says what the owner's opencode is doing, which is the very
 * thing the filter exists to withhold; `faults` moves when a handler throws, so an
 * anonymous caller reading it before and after a probe of their own learns
 * whether that probe found a defect — a search the relay would otherwise be
 * running for them, over the very bugs the swallowing exists to survive — and
 * `claims` is the same kind of thing for a flood, an "am I there yet" it should
 * not be told either. The operator's documented path is loopback (DEPLOY.md).
 *
 * `faults` never moves `ok`/`healthy`: a swallowed error is survivable by
 * definition, and failing the probe over one would restart the process and end
 * every live share — the very outage the swallowing exists to prevent. The
 * field is additive, so probes that read only the status, and those that read
 * the old body, are unaffected.
 */
export const healthRouter = (store: Store) => {
  const r = express.Router()
  r.get('/', (req, res) => {
    const body = { ok: true, healthy: true, sessions: store.sessionCount(), version: VERSION }
    if (fromOperatorSide(req))
      return res.json({ ...body, faults: faults(), claims: store.claimStats(), events_dropped: droppedGlobalEvents() })
    res.json(body)
  })
  return r
}
