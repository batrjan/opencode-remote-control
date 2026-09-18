import express from 'express'
import type { Store } from '../store.js'
import { clearViewerCookie } from './viewerCookie.js'
import { extractViewerToken, originAllowed } from '../proxy/adapter.js'

/**
 * POST /api/leave — a viewer hands their own token back.
 *
 * The counterpart to /api/activate, and the only revocation a VIEWER could
 * ask for: every other one belongs to the owner (stopping the share), to the
 * seat accounting, or to a window lapsing. Someone who joined from a borrowed
 * laptop or a machine in a meeting room had no way to end their own access —
 * the token they left behind kept working for up to a day, and for as long as
 * the share lived if a tab stayed open, since the idle window slides on every
 * use.
 *
 * Three things end together, or the residue defeats the point: the token at
 * the relay (Store.revokeViewer, which is what the proxy and the shell routes
 * check), the viewer's live event stream, which authenticated once at open,
 * and the cookie in the browser.
 *
 * Always 204, token or no token. This is a logout, not a lookup: answering
 * differently would turn it into an oracle for whether a token is live, and a
 * browser whose cookie has already lapsed still needs the cookie taken back.
 *
 * Origin-checked like every other state-changing POST (see originAllowed): a
 * cross-site form could otherwise log a viewer out of a share mid-sentence.
 * SameSite=Strict on the cookie already means such a request carries no token
 * and revokes nothing, so this is the second lock, not the first.
 */
export function leaveRouter(store: Store, endViewerStreams: (viewer_token: string) => void) {
  const router = express.Router()
  router.post('/', (req, res) => {
    if (!originAllowed(req)) {
      return res.status(403).json({ error: 'cross-origin request forbidden' })
    }
    const token = extractViewerToken(req)
    // Only a token that was actually dropped is worth the walk. endViewerStreams
    // scans every open viewer stream in the process — one process serves every
    // tenant's share — and this endpoint is unauthenticated by design, so a
    // token nobody ever issued used to buy that scan once per request. Nothing
    // was revoked, so there is nothing to end, and the answer is unchanged.
    if (token && store.revokeViewer(token)) {
      // The stream re-checks the token on its own heartbeat, so it would end
      // within seconds anyway; ending it here means the viewer who asked to
      // leave stops receiving the owner's screen at once.
      endViewerStreams(token)
    }
    clearViewerCookie(res)
    // Belt and braces for a shared machine: the UI state this origin holds for
    // the share the viewer is leaving — its drafts and prompt history in
    // IndexedDB, its settings in localStorage (the shells clear those on the
    // way IN, for the next share; this clears them on the way out, for the next
    // person), and what this host cached. Honoured over HTTPS only, which is
    // where a viewer cookie exists at all (secure:true).
    //
    // No "cookies": that directive is defined over the REGISTRABLE DOMAIN of
    // this origin, not over the origin — "we remove all the cookies for an
    // entire registered domain" (w3c/webappsec-clear-site-data), confirmed in
    // Chromium, where one host's response wiped two neighbouring hosts' own
    // cookies. A relay at opencode.example.com would be logging people out of
    // every other service under example.com, and its own cookie is already
    // taken back by clearViewerCookie above — by name, path and attributes.
    res.setHeader('Clear-Site-Data', '"cache", "storage"')
    return res.status(204).end()
  })
  return router
}
