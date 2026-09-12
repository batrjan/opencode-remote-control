import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { config } from './config.js'
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
  viewers: Map<string, ViewerToken> // salted hash -> { salt, created_at, last_used, index }
}

interface IpAttempts {
  minuteCount: number
  minuteStart: number
  hourCount: number
  hourStart: number
}

/** Minimum last_seen advance before it is worth re-persisting. */
const LAST_SEEN_PERSIST_THROTTLE_MS = 60_000

export class Store {
  private sessions: Map<string, Session> = new Map()
  private codeFails: Map<string, number> = new Map()
  private blockedCodes: Set<string> = new Set() // attempt-key hashes, never secrets
  private ipAttempts: Map<string, IpAttempts> = new Map()
  private sessionFails: Map<string, { count: number; windowStart: number }> = new Map()
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
  /** Called after anything that changes the session set (see setChangeListener). */
  private onChange: (() => void) | null = null

  /**
   * @param maxTrackingEntries cap for codeFails/blockedCodes/ipAttempts
   * (memory safety under brute force); oldest entry evicted when full.
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
   * hourly quota.
   */
  checkRegistrationLimit(ip: string): void {
    const now = Date.now()
    let rec = this.registrations.get(ip)
    if (!rec || now - rec.windowStart >= config.registrationWindowMs) {
      rec = { count: 0, windowStart: now }
      this.registrations.set(ip, rec)
    }
    if (rec.count >= config.registrationsPerWindow) {
      throw new Error('rate limited')
    }
    let active = 0
    for (const s of this.sessions.values()) {
      if (s.created_by_ip === ip && s.status === 'active') active += 1
    }
    if (active >= config.maxActiveSessionsPerIp) {
      throw new Error('rate limited')
    }
  }

  /**
   * Consume one registration slot for `ip`. Call only after the session was
   * really created — see checkRegistrationLimit. Re-resolves the window so a
   * commit that lands after the hour rolled over starts a fresh one.
   */
  commitRegistration(ip: string): void {
    const now = Date.now()
    let rec = this.registrations.get(ip)
    if (!rec || now - rec.windowStart >= config.registrationWindowMs) {
      rec = { count: 0, windowStart: now }
      this.registrations.set(ip, rec)
    }
    rec.count += 1
  }

  /**
   * Register a new session. Returns the secrets exactly once; only salted
   * hashes are stored. Throws 'session exists' on a duplicate id — a second
   * registration must never silently overwrite (and hijack) a live session.
   */
  createSession(session_id: string, directory: string, title: string, created_by_ip: string) {
    if (this.sessions.has(session_id)) throw new Error('session exists')
    const access_code = generateCode()
    const code_salt = newSalt()
    const code_hash = saltedHash(access_code, code_salt)
    const bridge_token = generateToken()
    const bridge_token_salt = newSalt()
    const bridge_token_hash = saltedHash(bridge_token, bridge_token_salt)
    const now = Date.now()
    const session: Session = {
      id: session_id,
      directory,
      title,
      code_hash,
      code_salt,
      bridge_token_hash,
      bridge_token_salt,
      created_at: now,
      last_seen: now,
      status: 'active',
      created_by_ip,
      viewers: new Map(),
    }
    this.sessions.set(session_id, session)
    this.changed()
    return { session_id, access_code, bridge_token, viewer_url: `/${session_id}` }
  }

  /**
   * Exchange an access code for a viewer token, bound to a specific session.
   * The code alone is NOT enough: callers must name the session (taken from
   * the viewer URL path). Throws 'rate limited' or 'invalid code' (single
   * error shape for missing/blocked codes and wrong sessions, per spec).
   */
  activate(code: string, session_id: string, ip: string) {
    // NOTE the order: the per-IP budget is checked on the FAILURE paths below,
    // not here. Gating the whole call on it refused a CORRECT code from an
    // address that had recently failed — and because this keys on the client
    // address, "the address" is a whole office behind one NAT: one colleague
    // mistyping five times locked out everyone else holding a good code. A
    // caller who presents the right code is not grinding, so nothing about
    // them needs throttling. Wrong guesses still cost exactly what they did.
    //
    // Per-session failure cap: after N failed activations against one session
    // (any code), that session is locked out for a window. This is the real
    // brute-force brake — the per-attempt-key counter below only stops
    // repeating the SAME wrong guess, which is pointless (one attempt already
    // proved it wrong). The session id is high-entropy and known to the
    // viewer (it's in their URL), so the threat is code-grinding per session.
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
      // Charged like any other miss: this path short-circuits before the hash
      // compare, so leaving it free would let an attacker spam a code they
      // already know is blocked without ever touching their budget.
      this.failActivation(ip)
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
      this.failActivation(ip)
    }
    // Successful activation clears the session's failure window.
    this.sessionFails.delete(session_id)
    const viewer_token = generateToken()
    const salt = newSalt()
    const issuedAt = Date.now()
    // Make room before minting: drop anything already idle-expired, then evict
    // down to one slot below the cap so the new token fits.
    this.pruneExpiredViewers(session, issuedAt)
    this.evictViewers(session, config.maxViewersPerSession - 1)
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
   * Drop viewers whose sliding idle window has elapsed. Called on every lookup
   * of a session and on activation, so expiry needs no sweeper of its own.
   * Deliberately does NOT mark the store dirty: this runs on the request path,
   * and restore() applies the same expiry to whatever the last snapshot held,
   * so an expired viewer can never come back from disk anyway.
   */
  private pruneExpiredViewers(session: Session, now: number): void {
    for (const [hash, viewer] of session.viewers) {
      if (now - viewer.last_used > config.viewerIdleTtlMs) {
        session.viewers.delete(hash)
        this.dropIndexEntry(session.id, viewer)
      }
    }
  }

  /**
   * Evict least-recently-used viewers until the session holds at most `max`.
   * Recency IS insertion order here (matchViewer re-inserts on every use), so
   * the first key is always the coldest token.
   */
  private evictViewers(session: Session, max: number): void {
    while (session.viewers.size > max) {
      const oldest = session.viewers.entries().next()
      if (oldest.done) return
      const [hash, viewer] = oldest.value
      session.viewers.delete(hash)
      this.dropIndexEntry(session.id, viewer)
    }
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
    this.sessions.delete(session_id)
    this.changed()
    return true
  }

  /** Accepts a plaintext code + session (hashed internally before lookup). */
  isCodeBlocked(session_id: string, code: string) {
    return this.blockedCodes.has(hashAttempt(`${session_id}:${normalizeCode(code)}`))
  }

  sessionCount() {
    return this.sessions.size
  }

  /**
   * Reap orphaned sessions: a session whose bridge never connected (or
   * disconnected long ago) and that has been idle longer than `maxIdleMs`
   * gets deleted (its code and tokens revoked). Prevents abandoned shares
   * from living forever (e.g. bridge killed -9, or a registration the owner
   * never followed through on). Returns the ids it removed.
   */
  reapOrphans(maxIdleMs: number): string[] {
    const now = Date.now()
    const removed: string[] = []
    for (const [id, session] of this.sessions) {
      if (now - session.last_seen > maxIdleMs) {
        this.dropViewers(session) // same revocation as deleteSession
        this.sessions.delete(id)
        removed.push(id)
      }
    }
    if (removed.length) this.changed()
    return removed
  }

  /** Refresh last_seen (bridge proxy/event traffic calls this). */
  touchSession(session_id: string): void {
    const s = this.sessions.get(session_id)
    if (!s) return
    const now = Date.now()
    const prev = s.last_seen
    s.last_seen = now
    // last_seen changes on every pong and every proxied request; persisting
    // each one would rewrite the whole state file several times a minute for a
    // best-effort timestamp. Only mark dirty when it moved enough to matter for
    // the idle reaper across a restart.
    if (now - prev >= LAST_SEEN_PERSIST_THROTTLE_MS) this.changed()
  }

  /**
   * Register a listener fired after every change to the session set. The
   * server uses it to persist a snapshot, so a restart no longer drops live
   * shares. Rate-limit state is intentionally out of scope.
   */
  setChangeListener(listener: (() => void) | null): void {
    this.onChange = listener
  }

  private changed(): void {
    this.onChange?.()
  }

  /** Serializable view of the session set (salted hashes only, no secrets). */
  snapshot(): PersistedState {
    return {
      version: STATE_VERSION,
      saved_at: Date.now(),
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
    for (const s of state.sessions) {
      if (!s || typeof s.id !== 'string' || !s.id) continue
      if (this.sessions.has(s.id)) continue
      if (typeof s.last_seen !== 'number' || now - s.last_seen > maxIdleMs) continue
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
        // A viewer already past its idle window is dropped rather than
        // resurrected — same policy as the idle sessions skipped above.
        if (now - last_used > config.viewerIdleTtlMs) continue
        viewers.set(v.hash, {
          salt: v.salt,
          created_at: v.created_at ?? now,
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
    return restored
  }

  /**
   * Map insert with FIFO eviction at the cap (JS Maps iterate in insertion
   * order, so the first key is the oldest). Evicting a counter/window only
   * resets bookkeeping, never a stored secret.
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
   * Reject one activation attempt: charge the address, then throw.
   *
   * ONLY failures are charged, and that is the whole point of this limit: the
   * budget exists to throttle code GRINDING, and grinding is made of wrong
   * guesses. A correct code is not an attack signal — it is proof the caller
   * already had the secret.
   *
   * Charging successes too had a cost paid entirely by legitimate users,
   * because this keys on the client ADDRESS: a team behind one office NAT, or
   * one corporate VPN, shares a single bucket, so the sixth colleague to join
   * the same share within a minute was told "too many attempts" while holding
   * a perfectly good code. Measured against the live relay — five accepted,
   * the sixth refused 429 with the right code in hand.
   *
   * Nothing about the brute-force defence moves: five wrong guesses a minute
   * and fifty an hour per address still applies, a specific wrong code is
   * still blocked after ten tries, and the per-session lockout (20 failures in
   * 15 minutes, address-independent) is still what actually stops an attacker
   * spreading the grind across many addresses.
   *
   * Over budget answers 'rate limited', under budget 'invalid code' — the same
   * two outcomes a grinding client saw before. The check runs BEFORE the
   * charge so an address that is already cut off cannot keep pushing its own
   * window forward.
   */
  private failActivation(ip: string): never {
    const rec = this.ipWindow(ip)
    if (rec.minuteCount >= config.ipLimitPerMinute || rec.hourCount >= config.ipLimitPerHour) {
      throw new Error('rate limited')
    }
    rec.minuteCount += 1
    rec.hourCount += 1
    throw new Error('invalid code')
  }

  /**
   * The per-IP activation window, rolled forward to `now`. Creating the record
   * on read is deliberate: an address that never fails never costs anything
   * beyond one bounded map entry.
   */
  private ipWindow(ip: string): IpAttempts {
    const now = Date.now()
    let rec = this.ipAttempts.get(ip)
    if (!rec) {
      rec = { minuteCount: 0, minuteStart: now, hourCount: 0, hourStart: now }
      this.setBounded(this.ipAttempts, ip, rec)
    }
    if (now - rec.minuteStart >= config.ipWindowMs.minute) {
      rec.minuteCount = 0
      rec.minuteStart = now
    }
    if (now - rec.hourStart >= config.ipWindowMs.hour) {
      rec.hourCount = 0
      rec.hourStart = now
    }
    return rec
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

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
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
