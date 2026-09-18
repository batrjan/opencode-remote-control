import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { config, departedBridgeMs, maxSessions } from './config.js'
import type { PersistedState } from './persist.js'
import { STATE_VERSION } from './persist.js'

export interface ViewerToken {
  salt: string
  created_at: number
  /**
   * Last successful authentication. The viewer window SLIDES on this: a token
   * in active use stays alive, one left idle past config.viewerIdleTtlMs stops
   * authenticating and is pruned.
   */
  last_used: number
  /**
   * The key this viewer occupies in the store-level lookup index (an unsalted
   * sha256 of the token, see viewerIndexKey). Held on the record so removing
   * the viewer — eviction, expiry, session delete — can drop its index entry
   * without the plaintext token, which the store never keeps. Undefined only
   * for a viewer restored from a state file written before the index existed;
   * it is filled in on that token's first successful authentication.
   */
  index?: string
}

export interface Session {
  id: string
  directory: string
  title: string
  code_hash: string
  code_salt: string
  bridge_token_hash: string
  bridge_token_salt: string
  created_at: number
  last_seen: number
  status: 'active' | 'closed'
  /** IP that registered the session — used for the public-registration cap. */
  created_by_ip: string
  /**
   * Salted hash of the owner_key the registering bridge proved its install
   * with (see createSession). Undefined for a registration without one.
   */
  owner_hash?: string
  owner_salt?: string
  /**
   * Set while no bridge has connected to this registration: when it was made,
   * or when this process restored it (the file cannot say how long the bridge
   * has had to reach this process). Cleared by the first touchSession, which
   * the bridge hub calls on connection. A registration that stays unbound past
   * config.unboundReapMs gives up its slot — see there.
   */
  unbound_since?: number
  /**
   * In memory only: the last sign of life from a bridge socket that had stayed
   * open for at least a ping interval (see touchSession). What a full relay
   * ranks departed shares by (evictDepartedShare) — not last_seen, which every
   * connection moves the moment it opens.
   */
  bridge_alive_at?: number
  viewers: Map<string, ViewerToken> // salted hash -> { salt, created_at, last_used, index }
}

/** An ended share's owner_key hash, reserving its id — see createSession. */
interface OwnerClaim {
  hash: string
  salt: string
  /** When the share ended; the claim lapses config.ownerClaimTtlMs later. */
  at: number
  /**
   * Which address block registered the share, as claimBucketKey computes it.
   * Only eviction reads it: a claim is displaced by the block that is
   * over-represented in the map, never merely by being the oldest (see
   * makeClaimRoom).
   */
  bucket: string
}

/**
 * How often mere activity (a session's last_seen, a viewer's last_used) may
 * mark the store dirty. Far inside the day restore() allows before it drops a
 * record as idle, so a crash loses at most this much of either.
 */
const ACTIVITY_PERSIST_THROTTLE_MS = 60_000

/** How often a full claims map may repeat itself in the log (noteClaimRefused). */
const CLAIM_REFUSAL_LOG_INTERVAL_MS = 3_600_000

export class Store {
  private sessions: Map<string, Session> = new Map()
  private codeFails: Map<string, number> = new Map()
  private blockedCodes: Set<string> = new Set() // attempt-key hashes, never secrets
  private sessionFails: Map<string, { count: number; windowStart: number }> = new Map()
  /** Successful activations per session in the current window — see config. */
  private sessionActivations: Map<string, { count: number; windowStart: number }> = new Map()
  private registrations: Map<string, { count: number; windowStart: number }> = new Map()
  /**
   * viewerIndexKey(token) -> session id. Viewer auth used to be a linear scan
   * over EVERY session x EVERY viewer (a SHA-256 + timingSafeEqual each) on
   * every proxied request; this makes the lookup O(1). It is a LOOKUP index,
   * never an authorization: a hit only says which session to ask, and the
   * per-token salted hash still decides the match.
   */
  private viewerIndex: Map<string, string> = new Map()
  /**
   * How many live viewer records carry no index entry (restored from a state
   * file written before the index existed). While this is zero — the steady
   * state — an unknown token can be rejected from the index alone, so garbage
   * tokens never trigger the fallback scan.
   */
  private unindexedViewers = 0
  /**
   * session id -> owner_key hash of the share that last held it. Read only for
   * ids no live session holds, but kept while a registration with the same key
   * holds one, for when that ends without a bridge (see recordClaim). Insertion
   * order is `at` order (recordClaim re-inserts), so expired claims are always
   * at the front. Capped at maxTrackingEntries like the tracking maps, but NOT
   * evicted like them — see makeClaimRoom.
   */
  private claims: Map<string, OwnerClaim> = new Map()
  /**
   * claimBucketKey -> the ids that block holds claims on, in `at` order (the
   * two maps are written together, and both re-insert). Kept so eviction can
   * ask which block is over-represented, and take that block's oldest claim,
   * without walking every claim in the map.
   */
  private claimBuckets: Map<string, Set<string>> = new Map()
  /**
   * Reservations a full map turned away, and when that was last said out loud
   * (see noteClaimRefused). Process-lifetime counters, not per window: the
   * question they answer is whether this relay is still reserving ids at all.
   */
  private claimsRefused = 0
  private claimRefusalWarnedAt = 0
  /** Called after anything that changes the session set, or activity on it (see setChangeListener). */
  private onChange: (() => void) | null = null
  /** Told when a registration ends — see onRegistrationEnd. */
  private endListeners: Set<(session_id: string) => void> = new Set()
  /** When the store last marked itself dirty — see noteActivity. */
  private lastDirtyAt = 0
  /** When restore() last loaded sessions from a previous process — see evictDepartedShare. */
  private restoredAt = 0

  /**
   * @param maxTrackingEntries cap for codeFails/blockedCodes/sessionFails/
   * registrations (memory safety under brute force); oldest entry evicted
   * when full.
   * Tests pass a small value to exercise eviction.
   */
  constructor(private maxTrackingEntries: number = config.maxTrackingEntries) {}

  /**
   * Public registration guard: how many sessions one IP may create per hour
   * and hold active at once. Registration is public (no shared key) so the
   * skill works out of the box — abuse is contained by these caps and by the
   * fact that deleting a session requires its bridge_token, not the public
   * path. Throws 'rate limited'.
   *
   * Checking does NOT consume a slot: callers commit with
   * commitRegistration(ip) once a session actually exists, so a request that
   * creates nothing (a duplicate id -> 409) no longer burns the caller's
   * hourly quota. Nor does it record anything: it used to create the
   * address's counter up front, so every refused request from a new address
   * left an entry behind.
   *
   * Throws 'relay full' when the relay already holds maxSessions() — see
   * there. `session_id` exempts a registration for an id that is live
   * already: that one replaces its session or ends in 409, never grows the
   * set, and refusing it would keep an owner out of its own share (its bridge
   * died) until the reaper removed the stale registration a day later.
   *
   * A full relay first removes the registrations no bridge connected to in
   * time (config.unboundReapMs) rather than wait up to a sweep interval for
   * the reaper: without that, bare POSTs from a pool of addresses kept every
   * new share out for as long as they cared to. If that frees nothing, it
   * gives up the slot of the share whose bridge has been gone longest (see
   * evictDepartedShare): one handshake per registration used to keep such a
   * relay full for a day.
   *
   * Making room ends someone's share, so it is done only for a registration
   * that will then exist: after the per-address limits, and never for an id
   * reserved for another install's owner_key (createSession answers that one
   * 409). Both used to be checked after the eviction, so a request refused
   * anyway had already ended a share. `owner_key` is the registration's, for
   * that check; `isConnected` says which sessions have a bridge socket right
   * now (the bridge hub's), none of which may be ended.
   */
  checkRegistrationLimit(
    ip: string,
    session_id?: string,
    owner_key?: string,
    isConnected: (session_id: string) => boolean = () => false,
  ): void {
    const full = () =>
      this.sessions.size >= maxSessions() && (session_id === undefined || !this.sessions.has(session_id))
    // Only the unbound criterion (no idle limit): none of those has a bridge
    // socket, so nothing is left for the caller to disconnect, and none is a
    // share anyone waits on — the reaper drops them anyway, so this may run for
    // a request refused below.
    if (full()) this.reapOrphans(Number.POSITIVE_INFINITY)
    const now = Date.now()
    const rec = this.registrations.get(ip)
    if (rec && now - rec.windowStart < config.registrationWindowMs && rec.count >= config.registrationsPerWindow) {
      throw new Error('rate limited')
    }
    let active = 0
    for (const s of this.sessions.values()) {
      if (s.created_by_ip === ip && s.status === 'active') active += 1
    }
    if (active >= config.maxActiveSessionsPerIp) {
      throw new Error('rate limited')
    }
    if (full()) {
      // Refused as 'session reserved' by createSession, whatever room it got.
      if (session_id !== undefined) {
        const claim = this.liveClaim(session_id, now)
        if (claim && !ownerKeyMatches(claim.hash, claim.salt, owner_key)) return
      }
      // Nor has the share evicted here a bridge socket (isConnected).
      this.evictDepartedShare(isConnected)
      if (full()) throw new Error('relay full')
    }
  }

  /**
   * Consume one registration slot for `ip`. Call only after the session was
   * really created — see checkRegistrationLimit. A commit that lands after the
   * hour rolled over starts a fresh window.
   *
   * The counters were a plain Map with one entry per address ever seen, never
   * removed — not when the sessions ended, not when the hour was up — so a
   * pool of addresses grew it without end. Now a record is inserted only when
   * its window starts and never moved afterwards, so Map order is windowStart
   * order and the lapsed ones sit at the front for pruneRegistrations; and it
   * is capped like the other tracking maps. Evicting one only resets that
   * address's hourly count; its active-session cap is counted from the
   * sessions themselves.
   */
  commitRegistration(ip: string): void {
    const now = Date.now()
    this.pruneRegistrations(now)
    const rec = this.registrations.get(ip)
    if (rec && now - rec.windowStart < config.registrationWindowMs) {
      rec.count += 1
      return
    }
    // Replaced rather than reset in place, so the order holds even for a lapsed
    // record pruning stopped short of (only after the clock stepped back).
    this.registrations.delete(ip)
    this.setBounded(this.registrations, ip, { count: 1, windowStart: now })
  }

  /** Drop registration counters whose window is over; they sit at the front (see commitRegistration). */
  private pruneRegistrations(now: number): void {
    for (const [ip, rec] of this.registrations) {
      if (now - rec.windowStart < config.registrationWindowMs) break
      this.registrations.delete(ip)
    }
  }

  /**
   * Register a new session. Returns the secrets exactly once; only salted
   * hashes are stored. Throws 'session exists' on a duplicate id — a second
   * registration must never silently overwrite (and hijack) a live session —
   * and 'session reserved' on an id an ended share keeps for its owner_key.
   *
   * Who may register an id. It is not a secret: it is in the share link, and
   * the owner registers that same id again whenever they share the
   * conversation. Keyed on nothing else, a freed id went to whoever asked
   * first — anyone holding an old link could register it the moment the owner
   * stopped (or the reaper removed a share whose bridge died), hold it for
   * good with a connected socket, and leave the owner a 409 with no token to
   * clear it. `owner_key` is the bridge's proof of which install shared the id
   * (an HMAC of this relay's origin and the id under a secret kept on the
   * owner's machine — bound to the relay, because every relay the bridge
   * registers with reads it in the clear, and a key some other relay was sent
   * must not replace a live share here):
   * - a live session registered with a key is replaced by a registration with
   *   the same key — its bridge died without a word, and a restart must not
   *   wait a day — and refused to anyone else. `replaced` tells the caller to
   *   drop the old bridge socket; the old code, token and viewers end here,
   *   unless the registration RESUMES the share instead (see below);
   * - an ended one stays reserved for that key (see recordClaim);
   * - an id never registered with a key behaves as before, so bridges that
   *   send none keep working. A live session registered without a key cannot
   *   be replaced: there is nothing to prove ownership against.
   *
   * RESUMING a share, and why it exists. A viewer is typically somewhere else
   * entirely, and the access code exists only in the owner's bridge.log on the
   * owner's machine — the very machine whose crash ends the share. Minting a
   * fresh code on every registration therefore sent every viewer back to a
   * code-entry page holding a code that no longer existed, with no way to be
   * told the new one, every time the owner's opencode died, the machine
   * rebooted, or the owner simply started the share again. So a registration
   * that proves BOTH the install (owner_key, as for a replacement) AND that it
   * still holds the code the relay minted for this very session (`access_code`)
   * continues that share: same code, same viewer tokens, same activation
   * budget. Everything else is a replacement exactly as before.
   *
   * The code is a proof, not a choice: the relay keeps only a salted hash of
   * it, so it can RECOGNISE the code it minted and can never restore or accept
   * one. A caller that presents anything else — nothing, a stale code, a code
   * for a session this relay no longer holds — gets a new share with a new
   * code, and the old share's viewers go with it.
   *
   * What this lengthens the life of: a leaked code now lives until the share is
   * stopped or the relay lets the session go, not until the owner's next crash.
   * What still ends it, all of it, code and every viewer token at once: DELETE
   * (`/remote-control/stop`), the reaper, eviction from a full relay, and a
   * restore that drops the session as idle — none of which leaves a session for
   * a code to be recognised against.
   */
  createSession(
    session_id: string,
    directory: string,
    title: string,
    created_by_ip: string,
    owner_key?: string,
    access_code?: string,
  ) {
    const now = Date.now()
    const existing = this.sessions.get(session_id)
    // Whether this registration continues the live share rather than replacing
    // it. Only ever reached past the owner check below, so the comparison is no
    // oracle: a caller who cannot already prove the install gets 'session
    // exists' without the code being looked at. Normalized like an activation,
    // so a code read back from a file somebody retyped still matches. A session
    // whose stored hash is EMPTY — restored from a plaintext state file, which
    // strips the code hash on the way out — matches nothing at all, checked
    // outright rather than left to the digest comparison.
    let resumed = false
    if (existing) {
      if (!ownerKeyMatches(existing.owner_hash, existing.owner_salt, owner_key)) throw new Error('session exists')
      resumed =
        access_code !== undefined &&
        existing.code_hash !== '' &&
        safeEqual(saltedHash(normalizeCode(access_code), existing.code_salt), existing.code_hash)
      if (!resumed) {
        // Same revocation as deleteSession: nothing of the old share may carry
        // over into the new one.
        this.dropViewers(existing)
        this.sessionActivations.delete(session_id)
      }
      // The old share ends here, so it earns its reservation now: the new
      // registration may never be taken up, and that one earns none. A resume
      // earns it for the same reason — the share continues, but the new
      // registration still has to be taken up by a bridge, and if it never is,
      // this is what keeps the id its owner's.
      this.recordClaim(existing, now)
    } else {
      const claim = this.liveClaim(session_id, now)
      // Not 'session exists': no share holds the id, so there is nothing to
      // stop, and only the install that shared it can take it for the rest of
      // the claim. That is what a refused bridge has to tell its owner — who
      // is typically that same person on another install, or on an older
      // plugin that sends no key after a rollback. All it adds for a caller is
      // that a keyed share of the id ended within the claim — no news to
      // anyone holding the link, which is where the id comes from.
      if (claim && !ownerKeyMatches(claim.hash, claim.salt, owner_key)) throw new Error('session reserved')
      // Kept, not consumed: it holds the same key as this registration, and it
      // is what still reserves the id if no bridge takes this one up (see
      // recordClaim). Nothing reads a claim while a live session holds its id.
    }
    // A fresh code starts with a clean failure lock. Misses counted under this
    // id were guesses at a code that ends here (the replaced share's) or at no
    // code at all (an id nobody held), so they say nothing about the new one —
    // and kept, they refused every viewer holding it for the rest of the
    // window. Only past the checks above: a refused registration must leave a
    // live share's lock alone, or anyone could lift it with a 409.
    //
    // A RESUME is the other way round, and the lock is deliberately kept: the
    // lock is counted against a CODE, and a resume keeps the code, so every
    // miss under this id is still a miss against the code that is still live.
    // Clearing it would hand a grinder its window back for free, and it would
    // not even have to ask — an owner restarting a share after a crash is
    // exactly what the lockout provokes. The owner's way out of a lock it did
    // not earn is the one it always was: a registration with no code, which
    // mints a new one and clears the lock with it.
    if (!resumed) this.sessionFails.delete(session_id)
    const code = resumed ? normalizeCode(access_code!) : generateCode()
    const code_salt = resumed ? existing!.code_salt : newSalt()
    const code_hash = resumed ? existing!.code_hash : saltedHash(code, code_salt)
    const bridge_token = generateToken()
    const bridge_token_salt = newSalt()
    const bridge_token_hash = saltedHash(bridge_token, bridge_token_salt)
    let owner_hash: string | undefined
    let owner_salt: string | undefined
    if (owner_key !== undefined) {
      owner_salt = newSalt()
      owner_hash = saltedHash(owner_key, owner_salt)
    }
    // A NEW record even for a resume, never the old one mutated: the record's
    // identity is what the proxy keys a registration's ancestry cache on (see
    // adapter.ts), and a rebuilt record simply starts that cache empty, which
    // costs a re-walk and grants nothing. What the resume carries over is the
    // two things the owner cannot hand out again — the code and the viewers.
    const session: Session = {
      id: session_id,
      directory,
      title,
      code_hash,
      code_salt,
      bridge_token_hash,
      bridge_token_salt,
      // The share continues, so its start time does; a replacement starts now.
      created_at: resumed ? existing!.created_at : now,
      last_seen: now,
      status: 'active',
      created_by_ip,
      owner_hash,
      owner_salt,
      // A replacement and a resume both: the old bridge is dropped, and the new
      // one dials in. Until it does, this registration is unbound like any
      // other — a resume whose bridge never arrives is reaped on the short
      // unbound clock, and its viewers go with it.
      unbound_since: now,
      // The same Map, so the store-level viewer index (keyed on the session id,
      // which has not changed) still points at live records.
      viewers: resumed ? existing!.viewers : new Map(),
    }
    this.sessions.set(session_id, session)
    this.changed()
    // Before the secrets go out: the new bridge cannot dial in, nor a new
    // viewer join, until the caller has them.
    //
    // Not for a resume: that listener exists to cut the event streams of
    // viewers whose tokens have just been revoked (see onRegistrationEnd), and
    // a resume revokes none — the streams are fed by session id, the tokens
    // behind them are still the store's, and the new bridge feeds the same
    // viewers the same share. Ending them would be the one thing this change
    // exists to prevent: the tab going back to a code-entry page.
    if (existing && !resumed) this.registrationEnded(session_id)
    return {
      session_id,
      access_code: code,
      bridge_token,
      viewer_url: `/${session_id}`,
      replaced: existing !== undefined,
      // The old bridge_token is minted afresh either way, so the old socket
      // still has to go; `resumed` only says what survived it.
      resumed,
    }
  }

  /** The unexpired claim on an id no live session holds, if any. */
  private liveClaim(session_id: string, now: number): OwnerClaim | undefined {
    const claim = this.claims.get(session_id)
    if (claim && now - claim.at > config.ownerClaimTtlMs) {
      this.dropClaim(session_id)
      return undefined
    }
    return claim
  }

  /**
   * Keep an ending session's id reserved for the key it was registered with.
   * Called wherever a session leaves the store — a delete by its bridge, the
   * reaper, its owner's replacement; restore() does the same for one it drops
   * as idle — because each of those frees the id, and a freed id is exactly
   * what a squatter holding the old link waits for. A session registered
   * without a key reserves nothing.
   *
   * Nor does a registration no bridge ever took up (Session.unbound_since): it
   * leaves whatever claim the id already had, from its last share with a
   * bridge, as it was. It used to reserve the id like a share, so one POST with
   * a key of the caller's own, for an id nobody had reserved (every id a
   * keyless bridge shares), became a 30-day claim once the unbound reaper
   * removed it, renewable by POSTing again, and the owner's next start got 409
   * for all of it. Holding such an id takes a bridge connection again.
   */
  private recordClaim(
    session: { id: string; owner_hash?: string; owner_salt?: string; unbound_since?: number; created_by_ip?: string },
    at: number,
  ): void {
    if (session.unbound_since !== undefined) return
    if (session.owner_hash === undefined || session.owner_salt === undefined) return
    this.pruneClaims(Date.now())
    const bucket = claimBucketKey(session.created_by_ip)
    // Renewing a claim the map already holds is never an insert: it takes no
    // new room, so it is never refused and displaces nobody. It is re-inserted
    // so Map order stays `at` order for pruneClaims.
    if (this.claims.has(session.id)) this.dropClaim(session.id)
    else if (this.claims.size >= this.maxTrackingEntries && !this.makeClaimRoom(bucket)) {
      this.noteClaimRefused()
      return
    }
    this.putClaim(session.id, { hash: session.owner_hash, salt: session.owner_salt, at, bucket })
  }

  /**
   * Count one id a full map left unreserved, and say so at most hourly.
   *
   * The refusal is invisible in every other direction: the registrant is not
   * told (their share was created — only the reservation behind it is missing),
   * the id is simply free again, and the first sign used to be an owner finding
   * out days later that a stranger had registered the id from their old link.
   *
   * Deduplicated because the state lasts as long as the map stays full, and
   * what fills the map is a flood: a line per refusal would be the flood
   * choosing the log's volume, which is the thing every other budget here
   * exists to stop. One line an hour says the same thing, and the counter in
   * /health carries the magnitude.
   */
  private noteClaimRefused(): void {
    this.claimsRefused += 1
    const now = Date.now()
    if (now - this.claimRefusalWarnedAt < CLAIM_REFUSAL_LOG_INTERVAL_MS) return
    this.claimRefusalWarnedAt = now
    console.warn(
      `[store] claims map full (${this.claims.size}): an ending share's id was not reserved for ` +
        `its owner and can be registered by anyone (${this.claimsRefused} refused so far)`,
    )
  }

  /**
   * What the reservation map is doing, for the operator side of /health: how
   * many ids it holds, and how many it has had to turn away since start. A
   * `refused` that is moving means the map is full and ended shares' ids are
   * no longer being kept for the installs that shared them.
   */
  claimStats(): { held: number; refused: number } {
    return { held: this.claims.size, refused: this.claimsRefused }
  }

  /**
   * Make room for one more claim, or say there is none to be had fairly.
   *
   * The claims map is an AUTHORIZATION record, not a counter: evicting an entry
   * hands someone else an id its owner still holds, for the 30 days of a claim
   * of their own. Under the plain oldest-first eviction the other tracking maps
   * use, that made the reservation a matter of volume — register, connect a
   * bridge, delete, enough times, and the oldest claim in the map was pushed
   * out whoever it belonged to. The verifier did it at the production cap.
   *
   * Room comes from the address block that is over-represented instead: the
   * largest bucket, preferring the caller's own on a tie, so a flood from one
   * block only ever displaces that block's own oldest claim. When the largest
   * bucket holds just one claim, the map is as evenly spread as its cap allows
   * and NOTHING is evicted — the new claim is not recorded, which leaves that
   * id unreserved, exactly as it was before reservations existed. Displacing
   * somebody at that point would be the flood succeeding, only spread over as
   * many address blocks as there are seats.
   *
   * The scan is over blocks, not claims, and only on a full map: reaching that
   * state at the real cap takes 100 000 registrations each with a bridge behind
   * it, and one block then covers however many of them came from it.
   */
  private makeClaimRoom(inserting: string): boolean {
    let victim: Set<string> | undefined
    for (const [key, ids] of this.claimBuckets) {
      if (ids.size < 2) continue
      if (victim === undefined || ids.size > victim.size || (ids.size === victim.size && key === inserting)) {
        victim = ids
      }
    }
    if (victim === undefined) return false
    // And only from a block no more concentrated than the inserting one: to
    // take room from a block holding N claims you must already hold N yourself.
    // Without this, "largest bucket" is a rule a flood chooses to lose: spend a
    // fresh /24 (or, free of charge, a fresh /64) per registration and every one
    // of your blocks holds a single claim, un-evictable by the rule above, while
    // the largest block in the map is the honest one — an office behind one NAT,
    // or an owner who shared two conversations in a row. That inverted the whole
    // point of bucketing. A flood that concentrates enough to pass this check is
    // back to displacing its own oldest claim, which is what the rule above
    // already handles.
    if (victim.size > (this.claimBuckets.get(inserting)?.size ?? 0)) return false
    const oldest = victim.values().next()
    if (oldest.done) return false
    this.dropClaim(oldest.value)
    return true
  }

  /** Add a claim to both the map and its bucket (see claimBuckets). */
  private putClaim(id: string, claim: OwnerClaim): void {
    this.claims.set(id, claim)
    const ids = this.claimBuckets.get(claim.bucket)
    if (ids) ids.add(id)
    else this.claimBuckets.set(claim.bucket, new Set([id]))
  }

  /** Remove a claim from both the map and its bucket, dropping an empty bucket. */
  private dropClaim(id: string): void {
    const claim = this.claims.get(id)
    if (!claim) return
    this.claims.delete(id)
    const ids = this.claimBuckets.get(claim.bucket)
    if (!ids) return
    ids.delete(id)
    if (ids.size === 0) this.claimBuckets.delete(claim.bucket)
  }

  /** Drop lapsed claims; they sit at the front of the map (see claims). */
  private pruneClaims(now: number): void {
    for (const [id, claim] of this.claims) {
      if (now - claim.at <= config.ownerClaimTtlMs) break
      this.dropClaim(id)
    }
  }

  /**
   * Exchange an access code for a viewer token, bound to a specific session.
   * The code alone is NOT enough: callers must name the session (taken from
   * the viewer URL path). Throws 'rate limited', 'session full' or 'invalid
   * code' (single error shape for missing/blocked codes and wrong sessions,
   * per spec). Nothing here knows the caller's address.
   */
  activate(code: string, session_id: string) {
    // Per-session failure cap: after N failed activations against one session
    // (any code, from any address), that session is locked out for a window.
    // This is the real brute-force brake — the per-attempt-key counter below
    // only stops repeating the SAME wrong guess, which is pointless (one
    // attempt already proved it wrong). The session id is high-entropy and
    // known to the viewer (it's in their URL), so the threat is code-grinding
    // per session.
    const now = Date.now()
    const sessFails = this.sessionFails.get(session_id)
    if (sessFails && sessFails.count >= config.sessionFailLockThreshold) {
      if (now - sessFails.windowStart < config.sessionFailLockMs) {
        throw new Error('rate limited')
      }
      this.sessionFails.delete(session_id)
    }
    const normalizedCode = normalizeCode(code)
    const attemptKey = hashAttempt(`${session_id}:${normalizedCode}`)
    if (this.blockedCodes.has(attemptKey)) {
      // Answered like any other miss, but not counted toward the session lock
      // again: each of the repeats that blocked it was already counted, and
      // trying a guess known to be wrong is not another try at the code.
      this.failActivation()
    }
    const session = this.sessions.get(session_id)
    const codeMatches =
      session !== undefined &&
      safeEqual(saltedHash(normalizedCode, session.code_salt), session.code_hash)
    if (!codeMatches) {
      const fails = (this.codeFails.get(attemptKey) ?? 0) + 1
      this.setBounded(this.codeFails, attemptKey, fails)
      if (fails >= config.codeFailBlockThreshold) this.addBounded(this.blockedCodes, attemptKey)
      const rec = this.sessionFails.get(session_id) ?? { count: 0, windowStart: now }
      if (now - rec.windowStart >= config.sessionFailLockMs) {
        rec.count = 0
        rec.windowStart = now
      }
      rec.count += 1
      this.setBounded(this.sessionFails, session_id, rec)
      this.failActivation()
    }
    // The code was right. From here on nothing that fails is an oracle: only a
    // caller who already holds the code can reach these branches.
    //
    // Per-session mint rate. The failure lock above only counts misses, so it
    // says nothing about a caller who keeps presenting a VALID code — this is
    // the bound on how fast tokens can be minted at all.
    const activations = this.sessionActivations.get(session_id) ?? { count: 0, windowStart: now }
    if (now - activations.windowStart >= config.activationSessionWindowMs) {
      activations.count = 0
      activations.windowStart = now
    }
    if (activations.count >= config.activationsPerSessionWindow) {
      throw new Error('rate limited')
    }
    // Successful activation clears the session's failure window.
    this.sessionFails.delete(session_id)
    const issuedAt = Date.now()
    // Make room before minting: drop anything already idle-expired, then
    // reclaim a seat nobody is sitting in. If every seat is occupied by
    // somebody still present, refuse this join rather than take theirs.
    this.pruneExpiredViewers(session, issuedAt)
    if (!this.evictViewers(session, config.maxViewersPerSession - 1, issuedAt)) {
      throw new Error('session full')
    }
    activations.count += 1
    this.setBounded(this.sessionActivations, session_id, activations)
    const viewer_token = generateToken()
    const salt = newSalt()
    const index = viewerIndexKey(viewer_token)
    session.viewers.set(saltedHash(viewer_token, salt), {
      salt,
      created_at: issuedAt,
      last_used: issuedAt,
      index,
    })
    this.viewerIndex.set(index, session.id)
    // last_seen must move BEFORE changed(): the listener persists a snapshot
    // synchronously, so the old order wrote the stale timestamp to disk.
    session.last_seen = issuedAt
    this.changed()
    return { session_id: session.id, viewer_token }
  }

  /** Check whether a bridge token belongs to a session (constant-time). */
  verifyBridgeToken(session_id: string, bridge_token: string): boolean {
    const session = this.sessions.get(session_id)
    if (!session) return false
    return safeEqual(saltedHash(bridge_token, session.bridge_token_salt), session.bridge_token_hash)
  }

  /**
   * Resolve the session a viewer token belongs to. The proxy adapter uses
   * this for forced session binding: the URL :id is always replaced by the
   * token's session. The index answers in O(1); the salted comparison in
   * matchViewer() is still what authenticates.
   */
  getSessionByViewerToken(viewer_token: string): Session | undefined {
    const key = viewerIndexKey(viewer_token)
    const indexed = this.viewerIndex.get(key)
    if (indexed === undefined) return this.scanForViewer(viewer_token, key)
    const session = this.sessions.get(indexed)
    if (!session) {
      // Nothing should leave an entry pointing at a dead session, but a stale
      // one must never authenticate — and must not linger either.
      this.viewerIndex.delete(key)
      return undefined
    }
    return this.matchViewer(session, viewer_token, key) ? session : undefined
  }

  /** Check whether a viewer token belongs to a session. */
  verifyViewer(session_id: string, viewer_token: string): boolean {
    const session = this.sessions.get(session_id)
    if (!session) return false
    const key = viewerIndexKey(viewer_token)
    const indexed = this.viewerIndex.get(key)
    // Indexed against a different session: it cannot also belong to this one.
    if (indexed !== undefined && indexed !== session_id) return false
    if (indexed === undefined && this.unindexedViewers === 0) return false
    return this.matchViewer(session, viewer_token, key)
  }

  /**
   * Constant-time check of `token` against one session's viewers, refreshing
   * the sliding idle window on success. The index only says WHICH session to
   * ask — this salted comparison is the credential check, so a forged or
   * stale index entry can never authenticate on its own.
   */
  private matchViewer(session: Session, token: string, key: string): boolean {
    const now = Date.now()
    this.pruneExpiredViewers(session, now)
    for (const [hash, viewer] of session.viewers) {
      if (!safeEqual(saltedHash(token, viewer.salt), hash)) continue
      viewer.last_used = now
      if (viewer.index === undefined) {
        // First use since a restore that could not carry the index key.
        viewer.index = key
        this.viewerIndex.set(key, session.id)
        this.unindexedViewers = Math.max(0, this.unindexedViewers - 1)
      }
      // Re-insert so Map order tracks RECENCY, not creation: Maps iterate in
      // insertion order, so evictViewers() can then simply drop the first
      // (coldest) entry and needs no separate LRU bookkeeping.
      session.viewers.delete(hash)
      session.viewers.set(hash, viewer)
      // Last, so a listener that snapshots at once sees the finished record.
      this.noteActivity(now)
      return true
    }
    return false
  }

  /**
   * Fallback for viewers restored from a state file written before the index
   * existed: their index key was never persisted and cannot be derived from a
   * salted hash, so they are found by scan once and indexed on the way out.
   * Skipped entirely when no such viewer is left, which is what keeps an
   * unknown token O(1) — the case an attacker controls.
   */
  private scanForViewer(token: string, key: string): Session | undefined {
    if (this.unindexedViewers === 0) return undefined
    for (const session of this.sessions.values()) {
      if (this.matchViewer(session, token, key)) return session
    }
    return undefined
  }

  /**
   * Drop viewers whose sliding idle window has elapsed, and those past the
   * absolute ceiling on a token's life whether or not they are in use (see
   * config.viewerMaxLifetimeMs — the sliding window alone let a tab that kept
   * streaming hold its token for the whole life of the share). Called on every
   * lookup of a session and on activation, so expiry needs no sweeper of its
   * own. Deliberately does NOT mark the store dirty: this runs on the request
   * path, and restore() applies the same expiry to whatever the last snapshot
   * held, so an expired viewer can never come back from disk anyway.
   */
  private pruneExpiredViewers(session: Session, now: number): void {
    for (const [hash, viewer] of session.viewers) {
      if (now - viewer.last_used > config.viewerIdleTtlMs || now - viewer.created_at > config.viewerMaxLifetimeMs) {
        session.viewers.delete(hash)
        this.dropIndexEntry(session.id, viewer)
      }
    }
  }

  /**
   * Hand a viewer token back: drop it and nothing else.
   *
   * The counterpart to activate(), and the only revocation a VIEWER can ask
   * for — everything else here is the owner ending a share, a seat being
   * reclaimed, or a window lapsing. Someone who joined from a machine that is
   * not theirs had no way to end their own access; now POST /api/leave calls
   * this. Deliberately not routed through matchViewer: that sets last_used,
   * and a token on its way out must not slide its window on the way.
   *
   * The same salted comparison as everywhere else decides the match, so a
   * forged index entry could not drop somebody else's token even in principle.
   * Returns whether a token was actually dropped; the endpoint answers the same
   * either way (it is a logout, not an oracle).
   */
  revokeViewer(viewer_token: string): boolean {
    const key = viewerIndexKey(viewer_token)
    const indexed = this.viewerIndex.get(key)
    const candidates =
      indexed !== undefined
        ? [this.sessions.get(indexed)]
        : // Only a viewer restored from a state file written before the index
          // existed can be missing from it (see scanForViewer).
          this.unindexedViewers > 0
          ? [...this.sessions.values()]
          : []
    for (const session of candidates) {
      if (!session) continue
      for (const [hash, viewer] of session.viewers) {
        if (!safeEqual(saltedHash(viewer_token, viewer.salt), hash)) continue
        session.viewers.delete(hash)
        this.dropIndexEntry(session.id, viewer)
        this.changed()
        return true
      }
    }
    return false
  }

  /**
   * Evict least-recently-used viewers until the session holds at most `max`.
   * Recency IS insertion order here (matchViewer re-inserts on every use), so
   * the first key is always the coldest token.
   */
  /**
   * Reclaim seats down to `max`, but only ones nobody is sitting in.
   *
   * Map order is recency (a successful match re-inserts), so the front of the
   * map is the least recently used — the right candidate. The guard is what
   * changed: a viewer seen inside config.viewerActiveWindowMs is present, and
   * a present viewer is never displaced to make room for a new one. Anyone
   * holding the access code could otherwise mint tokens until every existing
   * viewer had been pushed out: no access they lacked, but a silent eviction
   * of everyone else. Returns whether there is now room.
   */
  private evictViewers(session: Session, max: number, now: number): boolean {
    while (session.viewers.size > max) {
      const oldest = session.viewers.entries().next()
      if (oldest.done) break
      const [hash, viewer] = oldest.value
      if (now - viewer.last_used <= config.viewerActiveWindowMs) return false
      session.viewers.delete(hash)
      this.dropIndexEntry(session.id, viewer)
    }
    return session.viewers.size <= max
  }

  /** Remove a departing viewer's lookup entry (see viewerIndex). */
  private dropIndexEntry(session_id: string, viewer: ViewerToken): void {
    if (viewer.index === undefined) {
      this.unindexedViewers = Math.max(0, this.unindexedViewers - 1)
      return
    }
    // Only drop an entry that still points here: never delete another
    // session's lookup key on the (practically impossible) digest collision.
    if (this.viewerIndex.get(viewer.index) === session_id) this.viewerIndex.delete(viewer.index)
  }

  /** Forget a session's viewers, index entries included. */
  private dropViewers(session: Session): void {
    for (const viewer of session.viewers.values()) this.dropIndexEntry(session.id, viewer)
    session.viewers.clear()
  }

  getSession(session_id: string) {
    return this.sessions.get(session_id)
  }

  /** Remove a session; returns false when it did not exist (for 404 mapping). */
  deleteSession(session_id: string): boolean {
    const session = this.sessions.get(session_id)
    if (!session) return false
    // Revoke the viewer tokens with the session: a leftover index entry would
    // outlive what it points at.
    this.dropViewers(session)
    // ...and its mint counter and failure lock. An opencode session id is
    // reused when the same session is shared again, so a surviving counter
    // would charge the new share for the old one's joins, and a surviving lock
    // would refuse its fresh code for the old one's typos.
    this.sessionActivations.delete(session_id)
    this.sessionFails.delete(session_id)
    this.sessions.delete(session_id)
    // The id is free now, and it is in every link the owner handed out.
    this.recordClaim(session, Date.now())
    this.changed()
    this.registrationEnded(session_id)
    return true
  }

  /** Accepts a plaintext code + session (hashed internally before lookup). */
  isCodeBlocked(session_id: string, code: string) {
    return this.blockedCodes.has(hashAttempt(`${session_id}:${normalizeCode(code)}`))
  }

  sessionCount() {
    return this.sessions.size
  }

  sessionIds(): string[] {
    return [...this.sessions.keys()]
  }

  /**
   * Reap orphaned sessions: a session idle longer than `maxIdleMs` (its
   * bridge disconnected long ago), or one no bridge has connected to for
   * longer than `maxUnboundMs`, gets deleted (its code and tokens revoked).
   * Prevents abandoned shares from living forever (e.g. bridge killed -9, or
   * a registration the owner never followed through on). Returns the ids it
   * removed.
   *
   * The second limit is much shorter because a registration nobody took up is
   * not a share anyone is waiting on (see config.unboundReapMs). It used to
   * wait out the idle limit like any other, holding a slot of the relay's
   * session cap for a day.
   */
  reapOrphans(maxIdleMs: number, maxUnboundMs: number = config.unboundReapMs): string[] {
    const now = Date.now()
    const removed: string[] = []
    for (const [id, session] of this.sessions) {
      const neverBridged = session.unbound_since !== undefined && now - session.unbound_since > maxUnboundMs
      if (now - session.last_seen > maxIdleMs || neverBridged) {
        this.removeSession(session, now)
        removed.push(id)
      }
    }
    // Registration counters are otherwise pruned only by the next registration.
    this.pruneRegistrations(now)
    if (removed.length) this.changed()
    for (const id of removed) this.registrationEnded(id)
    return removed
  }

  /**
   * Make room on a full relay by ending the one share whose bridge has been
   * silent longest, provided it has been silent past departedBridgeMs() —
   * which no share with a bridge socket can be, so there is nothing for the
   * caller to disconnect. Only for checkRegistrationLimit: the periodic reaper
   * still leaves a quiet share its day, and exactly one goes, for the one slot
   * the registration asking needs.
   *
   * Registrations still waiting for their first bridge are not candidates; the
   * unbound rule already decides theirs. A restored share counts as seen at
   * the restore: its bridge was connected to the previous process and is
   * re-dialling this one on a backoff the downtime stretched, and last_seen in
   * the file says nothing about that (the same reasoning as unbound_since).
   *
   * "Silent" is counted from the last sign of life of a bridge that stayed a
   * ping interval (Session.bridge_alive_at), or from the registration when none
   * has. It used to be last_seen, which a connection moves as it opens, so a
   * handshake (connect, close) per session every departedBridgeMs, a few a
   * second for a whole relay from one host, kept sessions nobody bridged in
   * their slots — and the share ended in their place was an honest one whose
   * owner's laptop had gone to sleep. A bridge back from such a sleep has not
   * shown that life yet, so a connected session is never a candidate:
   * `isConnected` is the bridge hub's view.
   */
  private evictDepartedShare(isConnected: (session_id: string) => boolean): void {
    const now = Date.now()
    const silentFor = departedBridgeMs()
    let victim: Session | undefined
    let victimSeen = 0
    for (const session of this.sessions.values()) {
      if (session.unbound_since !== undefined) continue
      if (isConnected(session.id)) continue
      // A session this process created was seen after any restore anyway.
      const seen = Math.max(session.bridge_alive_at ?? session.created_at, this.restoredAt)
      if (now - seen <= silentFor) continue
      if (victim === undefined || seen < victimSeen) {
        victim = session
        victimSeen = seen
      }
    }
    if (victim === undefined) return
    this.removeSession(victim, now)
    this.changed()
    this.registrationEnded(victim.id)
    // Logged like the refusal it replaces (see maxSessions): a relay that is
    // merely busy now ends quiet shares instead of refusing new ones, and the
    // operator is the one who can give it more. The slot stays free until a
    // registration fills it, so there is at most one line per registration.
    console.warn(
      `[store] relay full: ended share session=${JSON.stringify(victim.id)} ` +
        `(no live bridge for ${Math.round((now - victimSeen) / 60_000)} min) to make room (RELAY_MAX_SESSIONS)`,
    )
  }

  /**
   * Take a session out of the store with everything that authenticated or
   * counted against it — the same revocation as deleteSession — and keep its id
   * for its owner (see recordClaim). The caller marks the store changed and
   * tells the end listeners once it is done.
   */
  private removeSession(session: Session, now: number): void {
    this.dropViewers(session)
    this.sessionActivations.delete(session.id)
    this.sessionFails.delete(session.id)
    this.sessions.delete(session.id)
    this.recordClaim(session, now)
  }

  /**
   * Refresh last_seen (bridge proxy/event traffic calls this, and so does a
   * bridge connecting). The first call also records that a bridge took the
   * registration up (see Session.unbound_since), and persists that at once
   * rather than within the activity throttle: a restart that missed it would
   * start the short unbound clock again for a share whose bridge may be asleep.
   *
   * `provenLife` marks a sign of life from a bridge socket that has stayed open
   * a ping interval: only that renews the clock a full relay ranks by (see
   * Session.bridge_alive_at). A connection as it opens, or a byte sent before
   * the socket has been around that long, still counts for everything else.
   */
  touchSession(session_id: string, provenLife = false): void {
    const s = this.sessions.get(session_id)
    if (!s) return
    const now = Date.now()
    s.last_seen = now
    if (provenLife) s.bridge_alive_at = now
    if (s.unbound_since !== undefined) {
      delete s.unbound_since
      this.changed()
      return
    }
    this.noteActivity(now)
  }

  /**
   * Mark the store dirty for a timestamp that moved, at most once per
   * ACTIVITY_PERSIST_THROTTLE_MS store-wide.
   *
   * last_seen changes on every pong and every proxied request, last_used on
   * every viewer request; persisting each one would rewrite the whole state
   * file several times a minute. The throttle used to compare against the
   * PREVIOUS touch instead, and a connected bridge touches every 25 s at most,
   * so the gap never came and nothing reached the file while a share was only
   * in use. A day of that and restore() dropped the share as idle: a redeploy
   * refused the still-running bridge with 401, which it takes as fatal. The
   * snapshot is store-wide, so one mark refreshes every session's timestamps.
   */
  private noteActivity(now: number): void {
    if (now - this.lastDirtyAt >= ACTIVITY_PERSIST_THROTTLE_MS) this.changed()
  }

  /**
   * Register a listener fired after every change to the session set, and at
   * most once a minute for activity on it (see noteActivity). The server uses
   * it to persist a snapshot, so a restart no longer drops live shares.
   * Rate-limit state is intentionally out of scope.
   */
  setChangeListener(listener: (() => void) | null): void {
    this.onChange = listener
  }

  /**
   * Be told whenever a registration ends: deleted by its bridge, reaped, or
   * replaced by its owner's new registration of the same id. Returns an
   * unsubscribe function. The listener runs after the store has let go of the
   * registration (its viewer tokens are already revoked) and, for a
   * replacement, before its caller hands out the new share's secrets.
   *
   * What it is for: a viewer's open event stream. It authenticates once, at
   * open, and is fed by session id, so a revoked viewer used to keep it until
   * the heartbeat's re-check, up to 15 s. Meanwhile the same id's next
   * registration (an owner's replacement dials in within a second) had its
   * live events delivered to every viewer of the share that had just ended.
   */
  onRegistrationEnd(listener: (session_id: string) => void): () => void {
    this.endListeners.add(listener)
    return () => {
      this.endListeners.delete(listener)
    }
  }

  /**
   * Runs on the request path and inside the reaper's timer, where an exception
   * would fail a finished delete with a 500 or end the process: a listener
   * that throws is logged, never rethrown.
   */
  private registrationEnded(session_id: string): void {
    for (const listener of [...this.endListeners]) {
      try {
        listener(session_id)
      } catch (err) {
        console.warn(`[store] registration end listener failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private changed(): void {
    this.lastDirtyAt = Date.now()
    this.onChange?.()
  }

  /** Serializable view of the session set (salted hashes only, no secrets). */
  snapshot(): PersistedState {
    const now = Date.now()
    return {
      version: STATE_VERSION,
      saved_at: now,
      sessions: Array.from(this.sessions.values()).map((s) => ({
        id: s.id,
        directory: s.directory,
        title: s.title,
        // The code hash is included here; FileStateStore drops it before a
        // PLAINTEXT write and keeps it (encrypted) when a key is configured.
        code_hash: s.code_hash,
        code_salt: s.code_salt,
        bridge_token_hash: s.bridge_token_hash,
        bridge_token_salt: s.bridge_token_salt,
        created_at: s.created_at,
        last_seen: s.last_seen,
        status: s.status,
        created_by_ip: s.created_by_ip,
        ...(s.owner_hash === undefined || s.owner_salt === undefined
          ? {}
          : { owner_hash: s.owner_hash, owner_salt: s.owner_salt }),
        ...(s.unbound_since === undefined ? {} : { unbound: true as const }),
        // Insertion order is recency order (see matchViewer), and restore()
        // preserves it, so the LRU eviction order survives a restart too.
        viewers: Array.from(s.viewers.entries()).map(([hash, v]) => ({
          hash,
          salt: v.salt,
          created_at: v.created_at,
          last_used: v.last_used,
          ...(v.index === undefined ? {} : { index: v.index }),
        })),
      })),
      claims: Array.from(this.claims.entries())
        .filter(([, c]) => now - c.at <= config.ownerClaimTtlMs)
        // The bucket travels with the claim so a restart cannot reset who is
        // over-represented in the map; FileStateStore drops it before a
        // PLAINTEXT write, as it drops the owner IP it is derived from.
        .map(([id, c]) => ({ id, hash: c.hash, salt: c.salt, at: c.at, bucket: c.bucket })),
    }
  }

  /**
   * Load a snapshot taken by a previous process. Sessions already idle past
   * `maxIdleMs` are dropped rather than resurrected — the reaper would remove
   * them on its next sweep anyway. Returns how many were restored.
   */
  restore(state: PersistedState | undefined, maxIdleMs: number = config.orphanReapMs): number {
    if (!state || state.version !== STATE_VERSION || !Array.isArray(state.sessions)) return 0
    const now = Date.now()
    let restored = 0
    const heldBefore = new Set(this.sessions.keys())
    // Collected first and inserted in `at` order, the order pruneClaims relies on.
    const claims: (OwnerClaim & { id: string })[] = []
    for (const c of Array.isArray(state.claims) ? state.claims : []) {
      if (!c || typeof c.id !== 'string' || !c.id || typeof c.hash !== 'string' || typeof c.salt !== 'string') continue
      if (typeof c.at !== 'number' || now - c.at > config.ownerClaimTtlMs) continue
      // A file with no bucket per claim — one written by an older relay, or a
      // plaintext one, where the bucket is stripped with the owner IP — gives
      // each claim a block of its own. That is the safe reading: a restored
      // claim is somebody's live reservation, and a shared fallback block would
      // make the whole restored set look like one registrant's flood and evict
      // itself down (see makeClaimRoom).
      claims.push({
        id: c.id,
        hash: c.hash,
        salt: c.salt,
        at: c.at,
        bucket: typeof c.bucket === 'string' && c.bucket ? c.bucket : `restored:${c.id}`,
      })
    }
    for (const s of state.sessions) {
      if (!s || typeof s.id !== 'string' || !s.id) continue
      if (this.sessions.has(s.id)) continue
      if (typeof s.last_seen !== 'number' || now - s.last_seen > maxIdleMs) {
        // Dropped as idle, which ends the share like the reaper would have:
        // its id stays reserved for its owner all the same — if a bridge ever
        // took it up (see recordClaim).
        if (
          s.unbound !== true &&
          typeof s.last_seen === 'number' &&
          now - s.last_seen <= config.ownerClaimTtlMs &&
          typeof s.owner_hash === 'string' &&
          typeof s.owner_salt === 'string'
        ) {
          claims.push({
            id: s.id,
            hash: s.owner_hash,
            salt: s.owner_salt,
            at: s.last_seen,
            // The session carries the address it was registered from, so this
            // claim gets its real block even from a file whose claim list has
            // none. A plaintext file has no owner IP either, and then this is
            // the same per-claim fallback as above.
            bucket: typeof s.created_by_ip === 'string' && s.created_by_ip ? claimBucketKey(s.created_by_ip) : `restored:${s.id}`,
          })
        }
        continue
      }
      // A restored session must at least carry a usable bridge_token hash —
      // without it the bridge can never reconnect and the owner can never
      // delete it. Guards a truncated or hand-edited state file too. The
      // access code is intentionally NOT persisted, so it cannot be required.
      if (typeof s.bridge_token_hash !== 'string' || typeof s.bridge_token_salt !== 'string') {
        continue
      }
      const viewers = new Map<string, ViewerToken>()
      for (const v of Array.isArray(s.viewers) ? s.viewers : []) {
        if (!v || typeof v.hash !== 'string' || typeof v.salt !== 'string') continue
        // last_used falls back to created_at (a file written before the field
        // existed) and then to now, so an upgrade never makes every restored
        // viewer look instantly idle.
        const last_used =
          typeof v.last_used === 'number'
            ? v.last_used
            : typeof v.created_at === 'number'
              ? v.created_at
              : now
        // A viewer already past its idle window — or past the absolute ceiling
        // on a token's life — is dropped rather than resurrected, the same
        // policy as the idle sessions skipped above and as pruneExpiredViewers.
        if (now - last_used > config.viewerIdleTtlMs) continue
        const created_at = v.created_at ?? now
        if (now - created_at > config.viewerMaxLifetimeMs) continue
        viewers.set(v.hash, {
          salt: v.salt,
          created_at,
          last_used,
          index: typeof v.index === 'string' && v.index ? v.index : undefined,
        })
      }
      this.sessions.set(s.id, {
        id: s.id,
        directory: s.directory ?? '',
        title: s.title ?? '',
        // Use the persisted code when it survived (encrypted file); otherwise
        // an empty hash/salt can never match a real 64-hex saltedHash, so
        // activate() safely fails and only already-joined viewers (on their
        // tokens) keep working. Either way this is never a crackable secret.
        code_hash: typeof s.code_hash === 'string' ? s.code_hash : '',
        code_salt: typeof s.code_salt === 'string' ? s.code_salt : '',
        bridge_token_hash: s.bridge_token_hash,
        bridge_token_salt: s.bridge_token_salt,
        created_at: s.created_at ?? now,
        last_seen: s.last_seen,
        status: s.status === 'closed' ? 'closed' : 'active',
        created_by_ip: typeof s.created_by_ip === 'string' ? s.created_by_ip : '',
        ...(typeof s.owner_hash === 'string' && typeof s.owner_salt === 'string'
          ? { owner_hash: s.owner_hash, owner_salt: s.owner_salt }
          : {}),
        // Its clock starts over: the file cannot say how long this process has
        // been reachable. Only on an explicit mark, so a file from a relay that
        // did not track bridges restores every session as a share with one.
        ...(s.unbound === true ? { unbound_since: now } : {}),
        viewers,
      })
      // Rebuild the lookup index for this session. No stale entry can point at
      // s.id: ids already present are skipped above, and deleteSession /
      // reapOrphans drop their entries with the session.
      for (const v of viewers.values()) {
        if (v.index === undefined) this.unindexedViewers += 1
        else this.viewerIndex.set(v.index, s.id)
      }
      restored += 1
    }
    if (restored > 0) this.restoredAt = now
    // A session this process already held was registered against its own
    // claims, not the file's; a claim it already holds is at least as recent
    // as the file. A claim on an id restored from the file stays: it is that
    // registration's key, and all that reserves the id if no bridge takes the
    // registration up (see recordClaim). Files from before that have none.
    for (const c of claims.sort((a, b) => a.at - b.at)) {
      if (heldBefore.has(c.id) || this.claims.has(c.id)) continue
      if (this.claims.size >= this.maxTrackingEntries && !this.makeClaimRoom(c.bucket)) {
        // Same refusal as a live one, and the same silence without this: a
        // restart would drop reservations the file still holds and say nothing.
        this.noteClaimRefused()
        continue
      }
      this.putClaim(c.id, { hash: c.hash, salt: c.salt, at: c.at, bucket: c.bucket })
    }
    return restored
  }

  /**
   * Map insert with FIFO eviction at the cap (JS Maps iterate in insertion
   * order, so the first key is the oldest). Evicting a counter/window only
   * resets bookkeeping, never a stored secret.
   *
   * Only for the counters, therefore: codeFails, blockedCodes, sessionFails,
   * sessionActivations and registrations. The claims map is bounded the same
   * way but NOT evicted this way — a claim is an authorization record, and
   * dropping the oldest one is how a flood used to take an id from its owner
   * (see makeClaimRoom).
   */
  private setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
    if (!map.has(key) && map.size >= this.maxTrackingEntries) {
      const oldest = map.keys().next()
      if (!oldest.done) map.delete(oldest.value)
    }
    map.set(key, value)
  }

  /** Set insert with the same FIFO eviction policy as setBounded. */
  private addBounded(set: Set<string>, value: string): void {
    if (!set.has(value) && set.size >= this.maxTrackingEntries) {
      const oldest = set.values().next()
      if (!oldest.done) set.delete(oldest.value)
    }
    set.add(value)
  }

  /**
   * Reject one activation attempt.
   *
   * A single outcome now: there is no per-address budget to charge, so every
   * rejected guess looks the same to the caller. What actually throttles a
   * grind is the per-SESSION consecutive-failure lock, applied at the top of
   * activate() — counted per session precisely because an attacker can change
   * address for free but cannot change which share they are attacking.
   */
  private failActivation(): never {
    throw new Error('invalid code')
  }




}

/**
 * Codes are generated from an alphabet that EXCLUDES 'O' and 'I' precisely
 * because they are confusable with '0' and '1'. A viewer types what they see
 * on the sharer's screen, so fold the confusable letters onto the digits the
 * generator can actually emit — otherwise excluding them made a misread code
 * unrecoverable ("invalid code") instead of harmless. This runs before the
 * code is hashed, so it applies to every comparison; the generator never emits
 * O or I, so the create side is unaffected.
 */
function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replaceAll('O', '0').replaceAll('I', '1')
}

/**
 * timingSafeEqual THROWS on a length mismatch, and a stored hash can be legally
 * EMPTY: a session restored from a plaintext state file has had its code hash
 * stripped, and a hand-edited file can hold anything. Treat differing lengths
 * as "no match" — they cannot be equal anyway, and the length of a hex digest
 * is not a secret, so nothing timing-sensitive leaks.
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Whether `owner_key` is the key behind a stored owner hash. Never for a
 * missing hash (a registration made without a key proves nothing either way)
 * or a missing key.
 */
function ownerKeyMatches(hash: string | undefined, salt: string | undefined, owner_key: string | undefined): boolean {
  if (hash === undefined || salt === undefined || owner_key === undefined) return false
  return safeEqual(saltedHash(owner_key, salt), hash)
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Which address block a registrant counts as, for claim eviction only.
 *
 * A single machine has as many addresses as it has ports to dial from, so
 * bucketing per address would be no bucketing at all; the block is the unit an
 * attacker has to pay for. IPv4 is folded to a /24 and IPv6 to a /64 — the
 * smallest block routinely handed to one subscriber, and the reason the cheap
 * IPv6 detour (a /64 is 18 million million million addresses) is closed.
 *
 * The result is a truncated digest, not the prefix: the map holds one entry per
 * ended share and is written to the state file, and neither needs to carry
 * anyone's address. 64 bits is far past collision by accident, and a collision
 * would only put two registrants in one bucket, which costs them eviction
 * priority and nothing else. Anything that is not an address (req.ip is
 * optional, and the store also runs with '') buckets under itself.
 */
function claimBucketKey(ip: string | undefined): string {
  return sha256Hex(`claim-bucket:${addressBlock(ip ?? '')}`).slice(0, 16)
}

/** The /24 or /64 of an address, or the input unchanged when it is neither. */
function addressBlock(ip: string): string {
  // Brackets and a zone id ('fe80::1%eth0') are notation, not address.
  let addr = ip.trim().replace(/^\[|\]$/g, '')
  const zone = addr.indexOf('%')
  if (zone !== -1) addr = addr.slice(0, zone)
  // An IPv4-mapped address ('::ffff:198.51.100.7') is an IPv4 client: nginx
  // hands one over whenever the relay listens on a dual-stack socket, and
  // folding it as IPv6 would give every such client the same /64.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr)
  if (mapped) addr = mapped[1]!
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(addr)) return addr.split('.').slice(0, 3).join('.')
  if (!addr.includes(':')) return addr
  // Expand '::' before taking the first four groups: '2001:db8::1' is
  // 2001:db8:0:0 for our purposes, not 2001:db8::1.
  const [head, tail, extra] = addr.split('::')
  if (extra !== undefined) return addr
  const left = head ? head.split(':') : []
  const right = tail === undefined ? [] : tail ? tail.split(':') : []
  const groups =
    tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  return groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')
}

/** Hash used only for rate-limit/counter keys (not a stored secret). */
function hashAttempt(input: string): string {
  return sha256Hex(input)
}

/**
 * Lookup key for the viewer index: a deterministic, UNSALTED digest of the
 * token. Unsalted is required (a salted hash cannot be looked up without
 * already knowing which salt to use) and safe here: a viewer token is 32
 * random bytes, so the digest is not brute-forceable and reveals nothing the
 * salted hash does not. It selects a candidate session; it never authorizes.
 */
function viewerIndexKey(token: string): string {
  return sha256Hex(token)
}

/** Salted SHA-256 for all stored secrets (codes, tokens). */
function saltedHash(input: string, salt: string): string {
  return createHash('sha256').update(salt + ':' + input).digest('hex')
}

function newSalt(): string {
  return randomBytes(config.saltBytes).toString('hex')
}

function generateToken(): string {
  return randomBytes(config.tokenBytes).toString('base64url')
}

/**
 * Uniform code generation from crypto.randomBytes with rejection sampling
 * to avoid modulo bias.
 */
function generateCode(): string {
  const alphabet = config.codeAlphabet
  const limit = 256 - (256 % alphabet.length)
  const out: string[] = []
  while (out.length < config.codeLength) {
    for (const byte of randomBytes(config.codeLength * 2)) {
      if (byte < limit) {
        out.push(alphabet[byte % alphabet.length]!)
        if (out.length === config.codeLength) break
      }
    }
  }
  return out.join('')
}
