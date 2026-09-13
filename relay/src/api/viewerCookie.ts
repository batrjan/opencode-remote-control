import type { Response } from 'express'
import { config } from '../config.js'

/**
 * How long a browser keeps the viewer cookie after the relay last sent it.
 *
 * Whether a viewer is still in is decided by the token's sliding idle window
 * at the relay (config.viewerIdleTtlMs), never by the cookie; the cookie only
 * has to outlive that window. It is sent again on every response that
 * authenticated a viewer by it, but the event stream also slides the token, on
 * each heartbeat, with no response to carry a cookie. Matched to the window, a
 * tab that kept its stream open for a day without making one request would
 * lose the cookie while its token was still live. The margin covers that tab.
 * A cookie whose token has expired costs nothing: it gets the same 401 and
 * code-entry page as no cookie at all. Never shorter than the window itself.
 */
const VIEWER_COOKIE_MAX_AGE_MS = 30 * 24 * 3_600_000

/**
 * Issue the viewer cookie, or issue it again, on this response.
 *
 * Called at activation and on every response that authenticated a viewer BY
 * THE COOKIE (the proxy's viewer check, the UI shell routes). It used to be set
 * at activation only. A browser counts Max-Age from the moment a cookie
 * arrives, so the cookie died a fixed time after the join however active the
 * viewer was, while the token in it kept sliding: a viewer using the share
 * every hour was on 401s and the code-entry page exactly 24 h after joining.
 *
 * Once per response: the proxy checks a POST's viewer twice (before parsing
 * the body, then in the handler), and one Set-Cookie is enough. Nothing is
 * added once the headers are out, where setting one would throw.
 */
export function setViewerCookie(res: Response, token: string): void {
  if (res.headersSent) return
  const queued = res.getHeader('Set-Cookie')
  const cookies = queued === undefined ? [] : Array.isArray(queued) ? queued : [String(queued)]
  if (cookies.some((c) => c.startsWith('viewer_token='))) return
  res.cookie('viewer_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    // Without maxAge this was a browser-session cookie: it died on browser
    // restart while the token stayed valid server-side, so the viewer was
    // bounced back to the join page for no reason.
    maxAge: Math.max(VIEWER_COOKIE_MAX_AGE_MS, config.viewerIdleTtlMs),
    // Explicit: the token is used on /session/* and /api/* alike, so it must
    // not inherit a path from wherever /api/activate happens to be mounted.
    path: '/',
  })
}
