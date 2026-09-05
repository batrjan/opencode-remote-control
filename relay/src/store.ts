import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { config } from './config'

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
  viewers: Map<string, ViewerToken> // salted hash -> { salt, created_at }
}

interface IpAttempts {
  minuteCount: number
  minuteStart: number
  hourCount: number
  hourStart: number
}

export class Store {
  private sessions: Map<string, Session> = new Map()
  private codeFails: Map<string, number> = new Map()
  private blockedCodes: Set<string> = new Set() // attempt-key hashes, never secrets
  private ipAttempts: Map<string, IpAttempts> = new Map()

  /**
   * Register a new session. Returns the secrets exactly once; only salted
   * hashes are stored.
   */
  createSession(session_id: string, directory: string, title: string) {
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
      viewers: new Map(),
    }
    this.sessions.set(session_id, session)
    return { session_id, access_code, bridge_token, viewer_url: '/join' }
  }

  /**
   * Exchange an access code for a viewer token.
   * Throws 'rate limited' or 'invalid code' (single error shape for missing
   * and blocked codes, per design spec).
   */
  activate(code: string, ip: string) {
    this.checkIpLimit(ip)
    const normalizedCode = normalizeCode(code)
    const attemptKey = hashAttempt(normalizedCode)
    if (this.blockedCodes.has(attemptKey)) throw new Error('invalid code')
    const session = this.findSessionByCode(normalizedCode)
    if (!session) {
      const fails = (this.codeFails.get(attemptKey) ?? 0) + 1
      this.codeFails.set(attemptKey, fails)
      if (fails >= config.codeFailBlockThreshold) this.blockedCodes.add(attemptKey)
      throw new Error('invalid code')
    }
    const viewer_token = generateToken()
    const salt = newSalt()
    session.viewers.set(saltedHash(viewer_token, salt), { salt, created_at: Date.now() })
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

  deleteSession(session_id: string) {
    this.sessions.delete(session_id)
  }

  /** Accepts a plaintext code (hashed internally before lookup). */
  isCodeBlocked(code: string) {
    return this.blockedCodes.has(hashAttempt(code))
  }

  sessionCount() {
    return this.sessions.size
  }

  private checkIpLimit(ip: string): void {
    const now = Date.now()
    let rec = this.ipAttempts.get(ip)
    if (!rec) {
      rec = { minuteCount: 0, minuteStart: now, hourCount: 0, hourStart: now }
      this.ipAttempts.set(ip, rec)
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

  /**
   * Per-code random salt makes a lookup table key impossible, so activation
   * verifies against every session with a constant-time compare. Session
   * count is low enough that O(n) is fine and preferable to unsalted hashes.
   */
  private findSessionByCode(code: string): Session | undefined {
    for (const session of this.sessions.values()) {
      const candidate = saltedHash(code, session.code_salt)
      if (timingSafeEqual(Buffer.from(candidate), Buffer.from(session.code_hash))) {
        return session
      }
    }
    return undefined
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
