import express from 'express'
import type { Store } from '../store.js'
import { activateFailDelayMs } from '../config.js'
import { MAX_SESSION_ID } from './skill.js'
import { setViewerCookie } from './viewerCookie.js'

/**
 * POST /api/activate — exchange an access code for a viewer token, issued as
 * the HttpOnly viewer cookie only; the body is `{ session_id }`.
 * Outside a lockout every wrong code gets the same 400 'invalid code'
 * (unknown, blocked, or bound to another session). 429 'rate limited' comes
 * from the share, never from the caller's address: its failure lock, which
 * refuses every code, the correct one included, or — for a correct code — its
 * per-window cap on minted tokens. 429 'session full' means the code was right
 * but every viewer seat is occupied.
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
    // Which share this attempt is about, for the log budget's per-share reserve
    // — and only when the share is real. A key nobody could have registered is
    // a key an attacker invents for free, and handing those a reserve would let
    // one grinder spend the whole reserve on made-up ids (see warnBudgeted).
    const share = store.getSession(sessionId) ? sessionId : undefined
    try {
      const { session_id, viewer_token } = store.activate(code, sessionId)
      // The first of many: every response that authenticates this viewer by
      // the cookie sends it again, so it slides with the token (see
      // setViewerCookie).
      setViewerCookie(res, viewer_token)
      // The cookie is the only copy the caller gets. The token used to be in
      // this body as well, from a design that kept it in localStorage; nothing
      // reads it (the join page checks res.ok and navigates to /<id>, which
      // authenticates by the cookie), and a body is readable by any script in
      // the join page, which an HttpOnly cookie is not.
      return res.json({ session_id })
    } catch (err) {
      if (err instanceof Error && err.message === 'rate limited') {
        warnBudgeted(`rate limited${shareTag(share)} ip=${ip}`, share)
        return res.status(429).json({ error: 'rate limited' })
      }
      // Distinct from every other rejection, and safe to be distinct: this one
      // is only ever reached AFTER the code matched, so it tells an attacker
      // nothing they did not already know. Telling the caller the share is
      // full — rather than "invalid code" — is the difference between a person
      // retrying a code that is fine and a person asking the owner for a seat.
      if (err instanceof Error && err.message === 'session full') {
        warnBudgeted(`session at viewer capacity${shareTag(share)} ip=${ip}`, share)
        return res.status(429).json({ error: 'session full' })
      }
      // Never log the attempted code (could be a typo'd real one); the IP is
      // the signal needed for abuse monitoring.
      warnBudgeted(`rejected code attempt${shareTag(share)} from ip=${ip}`, share)
      await delay(activateFailDelayMs())
      return res.status(400).json({ error: 'invalid code' })
    }
  })
  return router
}

/**
 * Name the share a line is about, when there IS one.
 *
 * The budget and its reserve are kept per share, but the lines said only which
 * address the attempt came from — and the address is the attacker's to choose,
 * so the three lines a ground share's reserve bought looked exactly like the
 * ninety-two the grinder wrote next to them. Only a REGISTERED id is ever
 * printed (`share` is undefined otherwise, see the caller): activation accepts
 * any string up to 128 bytes, so printing what the caller sent would put a
 * newline, and a forged `[activate]` line, straight into the log.
 */
function shareTag(share: string | undefined): string {
  return share === undefined ? '' : ` share=${share}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * How many [activate] lines a minute the relay will write, and the budget's
 * state. Modelled on the bridge's lifecycle log (BridgeClient.logLifecycle),
 * which is bounded for the same reason.
 *
 * Every rejection here is written at the pace a stranger chooses: activation is
 * public, it needs only a session id and six characters, and nginx's edge zone
 * allows roughly two guesses a second PER ADDRESS. Unbounded, the log's volume
 * was an input, not an output — and docker's rotation (docker-compose.yml)
 * would then be spent on noise the relay did not have to write.
 *
 * Sized so that everything a real deployment logs still goes out — a share
 * locking after five wrong codes, a full share turning people away, a team
 * mistyping a code — while a grind is cut off long before it fills a rotation
 * window. The FIRST lines of each window survive, which is the security signal:
 * that an attack started, and the address it came from. The last ones would say
 * the same thing a thousand times.
 *
 * The window alone was not enough, because it was process-wide while the edge
 * rate limit is per address: nginx lets one address make ~120 attempts a minute,
 * so one grinder could fill the window by itself and blind the relay to every
 * OTHER share for the rest of it — including the line saying a neighbour's share
 * had just locked, which is the trace a code-guessing attack leaves. So each
 * share also has a small reserve that the global count cannot eat: at most
 * PER_SHARE_RESERVED lines each, in a map of RESERVE_SHARES slots cleared with
 * the window.
 *
 * Those slots are NOT first-come. Registration is public, so an attacker's own
 * shares are as cheap as its guesses: sixteen of them took every slot on their
 * first line each (a slot is claimed when a share writes, not when the budget
 * runs out), made-up ids then finished the global budget, and every other share
 * in the process was silent for the rest of the window — the same blinding the
 * reserve exists to stop, bought with registrations instead of volume. Handing
 * the slot out lazily does not help, because the attacker just reorders. So a
 * share that has not written in this window TAKES a slot from whichever share
 * has spent the most of its reserve (see warnBudgeted).
 *
 * The price is the fixed ceiling: shares passing slots back and forth can write
 * past the global budget, one line per attempt, so the worst case is nginx's
 * per-address rate rather than 60 + 48 lines a minute. That is the side to err
 * on — a flood is loud and an operator sees it (and the suppressed-line tail
 * says so), while a blind spot is silent, and silence about one share while it
 * is being ground is exactly what the attack wants.
 *
 * The reserve is only ever given to a share that EXISTS (see the caller): ids
 * nobody registered are free to invent, and a grinder naming a new one each time
 * would otherwise spend the whole reserve on shares that are not there.
 */
const ACTIVATE_LOG_LINES_PER_MINUTE = 60
const PER_SHARE_RESERVED = 3
const RESERVE_SHARES = 16
const activateLog = {
  windowStart: 0,
  lines: 0,
  suppressed: 0,
  /** session id -> lines it has taken from its reserve in this window. */
  reserved: new Map<string, number>(),
  /** Armed while a window holds suppressed lines — see flushSuppressed. */
  flush: null as NodeJS.Timeout | null,
}

/**
 * Print what the window dropped, if anything, and disarm the timer.
 *
 * A budget that logged nothing about its own silence would turn a flood into a
 * QUIET log, which is a worse thing to hand an operator than a noisy one — the
 * gap would read as nothing having happened.
 */
function flushSuppressed(): void {
  if (activateLog.flush !== null) {
    clearTimeout(activateLog.flush)
    activateLog.flush = null
  }
  if (activateLog.suppressed === 0) return
  console.warn(`[activate] (${activateLog.suppressed} line(s) suppressed in the last minute)`)
  activateLog.suppressed = 0
}

/** Write one [activate] line, or count it as suppressed. */
function warnBudgeted(line: string, share: string | undefined): void {
  const now = Date.now()
  if (now - activateLog.windowStart >= 60_000) {
    flushSuppressed()
    activateLog.windowStart = now
    activateLog.lines = 0
    activateLog.reserved.clear()
  }
  const used = share === undefined ? undefined : activateLog.reserved.get(share)
  let reserved = false
  if (share !== undefined) {
    if (used !== undefined) reserved = used < PER_SHARE_RESERVED
    else if (activateLog.reserved.size < RESERVE_SHARES) reserved = true
    else {
      // Every slot is held and this share holds none — where "first come, first
      // served" blinds it for the rest of the window (see the block comment
      // above). Take the slot from the share that has spent the most of its
      // reserve instead; on a tie the one that took it earliest, since a Map
      // iterates in insertion order and the comparison is strict. A share
      // still writing is only ever displaced by a share that has not written
      // at all, so no attempt to blind another share can be cheaper than the
      // volume it writes about itself.
      let evict: string | undefined
      let worst = -1
      for (const [id, spent] of activateLog.reserved) {
        if (spent > worst) {
          worst = spent
          evict = id
        }
      }
      if (evict !== undefined) {
        activateLog.reserved.delete(evict)
        reserved = true
      }
    }
  }
  if (!reserved && activateLog.lines >= ACTIVATE_LOG_LINES_PER_MINUTE) {
    activateLog.suppressed += 1
    if (activateLog.flush === null) {
      // The tail used to be printed only by the NEXT line the relay wrote, so a
      // flood that stopped — a hit and run — took its own count with it and the
      // log said nothing at all. Close the window on a timer instead. unref'd:
      // this must never be the reason the process stays up.
      activateLog.flush = setTimeout(flushSuppressed, 60_000)
      activateLog.flush.unref()
    }
    return
  }
  if (reserved && share !== undefined) activateLog.reserved.set(share, (used ?? 0) + 1)
  activateLog.lines += 1
  console.warn(`[activate] ${line}`)
}
