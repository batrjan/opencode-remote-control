import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Session state that survives a relay restart.
 *
 * The store is a set of in-memory Maps, so redeploying the relay used to drop
 * every session and viewer token: viewers got a mid-stream EOF and then 401 on
 * their cookie and 404 on the join page, while their bridge was still running.
 * Persisting the sessions makes a restart invisible to both ends — the bridge
 * reconnects with the same bridge_token and every already-joined viewer's
 * cookie stays valid.
 *
 * SECURITY — the access code is only 6 chars (~30 bits), so a fast hash of it
 * beside its salt is effectively the code itself to anyone who reads the file.
 * The state file is therefore ENCRYPTED at rest (AES-256-GCM) with a key that
 * lives OUTSIDE the state volume (RELAY_STATE_KEY, from the host environment):
 *   - with a key, the FULL session — code hash included — is persisted, so a
 *     redeploy keeps live shares AND keeps their unused join codes working; a
 *     copy of the volume alone (a backup, a `docker cp`, a snapshot) is
 *     useless without the key.
 *   - with NO key, the file is plaintext and the code hash, code salt and
 *     owner IP are stripped before writing, so a plaintext state file still
 *     never carries a crackable credential (a redeploy then invalidates an
 *     unused code — the safe fallback).
 * Either way the plaintext access code, bridge token and viewer token are
 * never stored: the store only ever holds salted hashes. Rate-limit counters
 * are deliberately not persisted.
 */
export interface PersistedViewer {
  hash: string
  salt: string
  created_at: number
}

export interface PersistedSession {
  id: string
  directory: string
  title: string
  code_hash?: string
  code_salt?: string
  bridge_token_hash: string
  bridge_token_salt: string
  created_at: number
  last_seen: number
  status: 'active' | 'closed'
  created_by_ip?: string
  viewers: PersistedViewer[]
}

export interface PersistedState {
  version: 1
  saved_at: number
  sessions: PersistedSession[]
}

export const STATE_VERSION = 1

/** On-disk envelope for an encrypted state file. */
interface EncryptedEnvelope {
  enc: 'aes-256-gcm'
  iv: string
  tag: string
  ct: string
}

/**
 * Resolve the 32-byte encryption key from RELAY_STATE_KEY, or null when unset.
 * Accepts a 64-char hex or 44-char base64 key verbatim; anything else is
 * folded to 32 bytes with SHA-256 so any sufficiently-random secret works.
 */
export function stateKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.RELAY_STATE_KEY
  if (!raw) return null
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
  const b64 = Buffer.from(raw, 'base64')
  if (b64.length === 32) return b64
  return createHash('sha256').update(raw).digest()
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const envelope: EncryptedEnvelope = {
    enc: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  }
  return JSON.stringify(envelope)
}

function decrypt(envelope: EncryptedEnvelope, key: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]).toString('utf8')
}

function isEncrypted(value: unknown): value is EncryptedEnvelope {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as EncryptedEnvelope).enc === 'aes-256-gcm' &&
    typeof (value as EncryptedEnvelope).ct === 'string'
  )
}

/** Fields that must never touch a PLAINTEXT state file (kept only when encrypted). */
function stripSensitive(state: PersistedState): PersistedState {
  return {
    ...state,
    sessions: state.sessions.map((s) => {
      const { code_hash: _c, code_salt: _s, created_by_ip: _ip, ...safe } = s
      return safe
    }),
  }
}

/**
 * Debounced, atomic state file behind the store.
 *
 * Writes go to a sibling temp file and are renamed into place, so a crash
 * mid-write can never leave a half-parsed state file — the worst case is the
 * previous snapshot, which is exactly what a restart should fall back to.
 */
export class FileStateStore {
  private timer: NodeJS.Timeout | null = null
  private pending: (() => PersistedState) | null = null
  private closed = false
  private readonly key: Buffer | null

  constructor(
    private readonly file: string,
    private readonly debounceMs: number = 400,
    key: Buffer | null = stateKey(),
  ) {
    this.key = key
  }

  /** Whether writes are encrypted at rest (a key is configured). */
  get encrypted(): boolean {
    return this.key !== null
  }

  /** Read the snapshot, or undefined when absent, unreadable or malformed. */
  load(): PersistedState | undefined {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return undefined // first run, or the volume is not mounted yet
    }
    let text = raw
    try {
      const parsed = JSON.parse(raw) as unknown
      if (isEncrypted(parsed)) {
        // An encrypted file we cannot decrypt (no key, wrong key, tampering) is
        // treated as absent — start empty rather than crash or trust garbage.
        if (!this.key) return undefined
        text = decrypt(parsed, this.key)
      }
    } catch {
      return undefined
    }
    try {
      const state = JSON.parse(text) as PersistedState
      if (!state || state.version !== STATE_VERSION || !Array.isArray(state.sessions)) return undefined
      return state
    } catch {
      return undefined
    }
  }

  /** Queue a write; repeated calls inside the debounce window collapse. */
  schedule(snapshot: () => PersistedState): void {
    if (this.closed) return
    this.pending = snapshot
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.debounceMs)
    this.timer.unref?.()
  }

  /** Write any queued snapshot now (shutdown path). */
  flush(): void {
    const snapshot = this.pending
    this.pending = null
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!snapshot) return
    const tmp = `${this.file}.tmp`
    try {
      const state = snapshot()
      // Encrypted → persist everything (code included). Plaintext → strip the
      // credential-equivalent fields first, so a plaintext file is never a
      // code list even if a key is later removed.
      const body = this.key
        ? encrypt(JSON.stringify(state), this.key)
        : JSON.stringify(stripSensitive(state))
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(tmp, body, { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (err) {
      // Losing persistence degrades a restart; it must never fail a request.
      console.warn(`[persist] could not write ${this.file}: ${(err as Error).message}`)
      try {
        rmSync(tmp, { force: true })
      } catch {
        // nothing else to do
      }
    }
  }

  /** Stop accepting writes (after a final flush by the caller). */
  close(): void {
    this.closed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = null
  }
}
