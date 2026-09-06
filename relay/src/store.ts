import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { config } from './config.js'
import type { PersistedState } from './persist.js'
import { STATE_VERSION } from './persist.js'

export interface ViewerToken {
  salt: string
  created_at: number
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
  viewers: Map<string, ViewerToken> // salted hash -> { salt, created_at }
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
    this.checkIpLimit(ip)
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
    if (this.blockedCodes.has(attemptKey)) throw new Error('invalid code')
    const session = this.sessions.get(session_id)
    const codeMatches =
      session !== undefined &&
      timingSafeEqual(
        Buffer.from(saltedHash(normalizedCode, session.code_salt)),
        Buffer.from(session.code_hash),
      )
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
      throw new Error('invalid code')
    }
    // Successful activation clears the session's failure window.
    this.sessionFails.delete(session_id)
    const viewer_token = generateToken()
    const salt = newSalt()
    session.viewers.set(saltedHash(viewer_token, salt), { salt, created_at: Date.now() })
    this.changed()
    session.last_seen = Date.now()
    return { session_id: session.id, viewer_token }
  }

  /** Check whether a bridge token belongs to a session (constant-time). */
  verifyBridgeToken(session_id: string, bridge_token: string): boolean {
    const session = this.sessions.get(session_id)
    if (!session) return false
    const candidate = saltedHash(bridge_token, session.bridge_token_salt)
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(session.bridge_token_hash))
  }

  /**
   * Resolve the session a viewer token belongs to. The proxy adapter uses
   * this for forced session binding: the URL :id is always replaced by the
   * token's session. O(sessions × viewers) with constant-time compares —
   * same trade-off as findSessionByCode.
   */
  getSessionByViewerToken(viewer_token: string): Session | undefined {
    for (const session of this.sessions.values()) {
      for (const [hash, { salt }] of session.viewers) {
        const candidate = saltedHash(viewer_token, salt)
        if (timingSafeEqual(Buffer.from(candidate), Buffer.from(hash))) return session
      }
    }
    return undefined
  }

  /** Check whether a viewer token belongs to a session. */
  verifyViewer(session_id: string, viewer_token: string): boolean {
    const session = this.sessions.get(session_id)
    if (!session) return false
    for (const [hash, { salt }] of session.viewers) {
      const candidate = saltedHash(viewer_token, salt)
      if (timingSafeEqual(Buffer.from(candidate), Buffer.from(hash))) return true
    }
    return false
  }

  getSession(session_id: string) {
    return this.sessions.get(session_id)
  }

  /** Remove a session; returns false when it did not exist (for 404 mapping). */
  deleteSession(session_id: string): boolean {
    const existed = this.sessions.delete(session_id)
    if (existed) this.changed()
    return existed
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
        viewers: Array.from(s.viewers.entries()).map(([hash, v]) => ({
          hash,
          salt: v.salt,
          created_at: v.created_at,
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
        if (v && typeof v.hash === 'string' && typeof v.salt === 'string') {
          viewers.set(v.hash, { salt: v.salt, created_at: v.created_at ?? now })
        }
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

  private checkIpLimit(ip: string): void {
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
    if (rec.minuteCount >= config.ipLimitPerMinute || rec.hourCount >= config.ipLimitPerHour) {
      throw new Error('rate limited')
    }
    rec.minuteCount += 1
    rec.hourCount += 1
  }

}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase()
}

/** Hash used only for rate-limit/counter keys (not a stored secret). */
function hashAttempt(input: string): string {
  return createHash('sha256').update(input).digest('hex')
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
