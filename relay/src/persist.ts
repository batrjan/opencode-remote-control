import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

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
  /**
   * Last time this token authenticated — the store's sliding idle window.
   * OPTIONAL, and STATE_VERSION deliberately stays 1: a version bump makes
   * load() refuse the whole file, which on the deploy that shipped this
   * change would end every live share. A file written by an older
   * relay simply has no last_used, and restore() falls back to created_at.
   */
  last_used?: number
  /**
   * Unsalted sha256 of the viewer token — the key this viewer occupies in the
   * store's O(1) lookup index, persisted because the plaintext token is never
   * stored and the digest cannot be recomputed from the salted hash. Safe to
   * write: a viewer token is 32 random bytes, so this digest is no more
   * invertible than the salted hash sitting next to it, and it is never a
   * credential on its own (the salted comparison still gates every match).
   * Optional for the same backward-compatibility reason as last_used; a
   * viewer restored without it is re-indexed on its first successful use.
   */
  index?: string
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
  /**
   * Salted hash of the owner_key the session was registered with (see
   * Store.createSession); absent for a registration without one. Kept in a
   * plaintext file too: the key is a 256-bit HMAC, so unlike the access code
   * its hash is no credential. Optional for the same reason as last_used.
   */
  owner_hash?: string
  owner_salt?: string
  /**
   * True while no bridge had connected to the registration (see
   * Session.unbound_since). Only a boolean: restore() starts that clock over.
   * Absent means a bridge had, and so does a file from an older relay, which
   * never tracked it: taking its live shares for registrations nobody took up
   * would end them minutes after the deploy. An older relay ignores the field.
   */
  unbound?: true
  viewers: PersistedViewer[]
}

/**
 * The owner_key hash of a share that ended: its session id stays reserved for
 * that key until `at` + config.ownerClaimTtlMs. Persisted because a restart
 * that forgot them would hand every ended share's id to whoever registers it
 * first, which is what the reservation exists to prevent. Its id may also be
 * held by a live registration with the same key (see Store.recordClaim); an
 * older relay skips such a claim on restore, as it always did.
 */
export interface PersistedClaim {
  id: string
  hash: string
  salt: string
  at: number
}

export interface PersistedState {
  version: 1
  saved_at: number
  sessions: PersistedSession[]
  /** Optional, STATE_VERSION unchanged: a file from an older relay has none. */
  claims?: PersistedClaim[]
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
  const tag = Buffer.from(envelope.tag, 'base64')
  // GCM's integrity guarantee is only as strong as the tag it verifies. Node
  // otherwise accepts a truncated tag (4/8/12 bytes) and checks only that many
  // bits, so a forger who can shave the tag needs far less work to slip a
  // tampered file past. We always write the full 128-bit tag, so pin
  // authTagLength to 16 AND reject any tag that is not exactly 16 bytes.
  if (tag.length !== 16) throw new Error('GCM auth tag is not 16 bytes')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'), { authTagLength: 16 })
  decipher.setAuthTag(tag)
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

/**
 * Array elements (sessions, claims) a background write encodes per event-loop
 * turn. A session is at most a few KB of registration fields plus its
 * viewers, so one turn stays in the low milliseconds however large the state.
 */
const ITEMS_PER_TURN = 50

/**
 * JSON.stringify(state), a piece at a time: its arrays are encoded
 * ITEMS_PER_TURN elements per event-loop turn. Joined, the pieces are exactly
 * the text JSON.stringify returns.
 */
async function* jsonPieces(state: PersistedState): AsyncGenerator<string> {
  let separator = '{'
  for (const [name, value] of Object.entries(state)) {
    if (value === undefined) continue
    yield `${separator}${JSON.stringify(name)}:`
    separator = ','
    if (!Array.isArray(value)) {
      yield JSON.stringify(value)
      continue
    }
    yield '['
    for (let i = 0; i < value.length; i += ITEMS_PER_TURN) {
      await new Promise((resolve) => setImmediate(resolve))
      // Encoded as an array and unwrapped, so every element gets exactly the
      // treatment JSON.stringify gives it inside the whole.
      yield (i === 0 ? '' : ',') + JSON.stringify(value.slice(i, i + ITEMS_PER_TURN)).slice(1, -1)
    }
    yield ']'
  }
  yield separator === '{' ? '{}' : '}'
}

/**
 * encrypt(), a piece at a time. The tag is known only at the end, so the
 * envelope lists it after `ct` — an order JSON.parse does not care about.
 */
async function* encryptedPieces(pieces: AsyncIterable<string>, key: Buffer): AsyncGenerator<string> {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  yield `{"enc":"aes-256-gcm","iv":"${iv.toString('base64')}","ct":"`
  // Base64 chunks join into one valid string only when each encodes whole
  // 3-byte groups: the remainder waits for the next piece.
  let carry = Buffer.alloc(0)
  for await (const piece of pieces) {
    const bytes = Buffer.concat([carry, cipher.update(piece, 'utf8')])
    const whole = bytes.length - (bytes.length % 3)
    carry = bytes.subarray(whole)
    if (whole > 0) yield bytes.subarray(0, whole).toString('base64')
  }
  const rest = Buffer.concat([carry, cipher.final()])
  yield `${rest.toString('base64')}","tag":"${cipher.getAuthTag().toString('base64')}"}`
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
 *
 * A debounced write runs in the background, a slice of the state per
 * event-loop turn. Every change rewrites the whole session set, and the write
 * used to be synchronous — encode, encrypt, writeFileSync, all in one turn —
 * so the relay served nothing for as long as it took: no viewer request, no
 * SSE heartbeat, no bridge pong. Public registration can grow the set to
 * thousands of sessions of a few KB each; at 10,000 that was ~350 ms of
 * nothing after every change. Only flush(), the shutdown path, still writes
 * synchronously: nothing may be left in flight when the process exits.
 */
export class FileStateStore {
  private timer: NodeJS.Timeout | null = null
  private pending: (() => PersistedState) | null = null
  private closed = false
  private readonly key: Buffer | null
  /** The background write in progress: the snapshot it is writing, and when it is done. */
  private writing: { snapshot: () => PersistedState; done: Promise<void> } | null = null
  /**
   * Bumped by every write that starts, and by close(). A background write
   * renames its file into place only if nothing bumped it meanwhile, so an
   * older snapshot never lands over the newer one a flush() wrote.
   */
  private generation = 0
  /** load() found a file it could not use; the first write moves it aside. */
  private unreadable = false

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

  /**
   * Read the snapshot, or undefined when absent, unreadable or malformed.
   *
   * Only an absent file is a quiet "no state". Every other failure used to be
   * one too, so a relay that could not read its file — the wrong
   * RELAY_STATE_KEY after a lost .env or a rotation, no key at all, a foreign
   * version — logged exactly what a first run logs, and the first write then
   * renamed a new snapshot over the only copy. Now the reason is logged, and
   * the file is moved aside by that first write (see setAsideUnreadable). Not
   * here: a relay restarted with the right key before anything was written
   * still finds the file where it was, and restores from it.
   */
  load(): PersistedState | undefined {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (err) {
      // First run, or the volume is not mounted yet.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      return this.unusable(`could not read it (${(err as Error).message})`)
    }
    let state: unknown
    try {
      state = JSON.parse(raw)
    } catch {
      return this.unusable('not valid JSON')
    }
    if (isEncrypted(state)) {
      // An encrypted file we cannot decrypt (no key, wrong key, tampering) is
      // never trusted — start empty rather than crash or trust garbage.
      if (!this.key) return this.unusable('encrypted but RELAY_STATE_KEY is not set')
      let text: string
      try {
        text = decrypt(state, this.key)
      } catch {
        return this.unusable('could not decrypt (wrong RELAY_STATE_KEY or tampered file)')
      }
      try {
        state = JSON.parse(text)
      } catch {
        return this.unusable('decrypted, but not valid JSON')
      }
    } else if (this.key) {
      // A key is configured, so every state file this relay writes is an
      // encrypted envelope. A plaintext file here is therefore not one we
      // wrote with this key: it is either a pre-encryption leftover or, worse,
      // forged by someone who can write the state volume but does not know the
      // key. Trusting it would let such an attacker substitute arbitrary
      // sessions, viewer tokens and code hashes without ever holding the key —
      // the exact threat the encryption exists to close. Treat it as corrupt:
      // set aside, start empty, and say why.
      return this.unusable('plaintext state file but RELAY_STATE_KEY is set (forged or pre-encryption leftover)')
    }
    const version = (state as { version?: unknown } | null)?.version
    if (!state || typeof state !== 'object' || typeof version !== 'number') return this.unusable('invalid shape')
    if (version !== STATE_VERSION) return this.unusable(`unsupported version ${version}`)
    if (!Array.isArray((state as PersistedState).sessions)) return this.unusable('invalid shape')
    return state as PersistedState
  }

  /** load()'s answer for a file that is there but cannot be used: say why, and keep it. */
  private unusable(reason: string): undefined {
    this.unreadable = true
    console.warn(
      `[persist] ignoring ${this.file}: ${reason}. Starting with no sessions; the file is moved to ` +
        `${this.file}.unreadable-<epoch ms> before anything is written in its place.`,
    )
    return undefined
  }

  /**
   * Move a file load() could not use out of the way of the write about to
   * land in its place. Renamed over, it would be gone for good, and with it
   * every share a corrected RELAY_STATE_KEY could still have restored. Runs
   * once, right before that rename and in the same synchronous step.
   */
  private setAsideUnreadable(): void {
    if (!this.unreadable) return
    this.unreadable = false
    const aside = `${this.file}.unreadable-${Date.now()}`
    try {
      renameSync(this.file, aside)
      console.warn(`[persist] moved the unreadable ${this.file} to ${aside}`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return // removed meanwhile: nothing to keep
      console.warn(`[persist] could not set aside the unreadable ${this.file}, writing over it: ${(err as Error).message}`)
    }
  }

  /**
   * Queue a background write; repeated calls inside the debounce window
   * collapse, and so do calls while a write is in progress: that write arms
   * the next one when it is done.
   */
  schedule(snapshot: () => PersistedState): void {
    if (this.closed) return
    this.pending = snapshot
    if (this.timer || this.writing) return
    this.arm()
  }

  private arm(): void {
    this.timer = setTimeout(() => {
      this.timer = null
      this.startWrite()
    }, this.debounceMs)
    this.timer.unref?.()
  }

  /** Resolves once no background write is in progress — for a caller about to read the file. */
  async settled(): Promise<void> {
    while (this.writing) await this.writing.done
  }

  private startWrite(): void {
    const snapshot = this.pending
    if (!snapshot || this.writing) return
    this.pending = null
    const generation = ++this.generation
    const done = this.writeInBackground(snapshot, generation).finally(() => {
      this.writing = null
      if (this.pending && !this.closed && !this.timer) this.arm()
    })
    this.writing = { snapshot, done }
  }

  private async writeInBackground(snapshot: () => PersistedState, generation: number): Promise<void> {
    // Not flush()'s temp file: a flush can run while this one is still open.
    const tmp = `${this.file}.bg.tmp`
    try {
      const state = snapshot()
      const body = this.key ? encryptedPieces(jsonPieces(state), this.key) : jsonPieces(stripSensitive(state))
      mkdirSync(path.dirname(this.file), { recursive: true })
      await pipeline(body, createWriteStream(tmp, { mode: 0o600 }))
      // Checked and renamed in one synchronous step, so no flush() can slip in
      // between.
      if (generation !== this.generation) {
        rmSync(tmp, { force: true })
        return
      }
      this.setAsideUnreadable()
      renameSync(tmp, this.file)
    } catch (err) {
      console.warn(`[persist] could not write ${this.file}: ${(err as Error).message}`)
      try {
        rmSync(tmp, { force: true })
      } catch {
        // nothing else to do
      }
    }
  }

  /** Write any queued snapshot now, synchronously (shutdown path). */
  flush(): void {
    // A background write in progress has not reached the file yet: redo it
    // here, or a process exiting right after this flush would lose it.
    const snapshot = this.pending ?? this.writing?.snapshot ?? null
    this.pending = null
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!snapshot) return
    this.generation += 1
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
      this.setAsideUnreadable()
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
    this.generation += 1 // a write still in progress lands nothing either
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = null
  }
}
