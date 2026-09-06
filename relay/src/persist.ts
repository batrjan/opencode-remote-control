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
 * What is written: the bridge_token hash (so the bridge can reconnect and the
 * owner can still delete) and each already-issued viewer-token hash (256-bit
 * secrets, safe to store). What is deliberately NOT written:
 *   - the ACCESS CODE hash. The code is only 6 chars (~30 bits), so a fast
 *     hash of it beside its salt is effectively the code itself to anyone who
 *     reads the file. Dropping it means a redeploy invalidates a code that was
 *     never used — already-joined viewers keep working on their tokens; a late
 *     joiner just needs a fresh share. That is a far better trade than shipping
 *     a crackable join code to disk.
 *   - the owner IP and the rate-limit counters (short-window, not needed after
 *     a restart, and PII we have no reason to keep).
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
  bridge_token_hash: string
  bridge_token_salt: string
  created_at: number
  last_seen: number
  status: 'active' | 'closed'
  viewers: PersistedViewer[]
}

export interface PersistedState {
  version: 1
  saved_at: number
  sessions: PersistedSession[]
}

export const STATE_VERSION = 1

/**
 * Debounced, atomic JSON file behind the store.
 *
 * Writes go to a sibling temp file and are renamed into place, so a crash
 * mid-write can never leave a half-parsed state file — the worst case is the
 * previous snapshot, which is exactly what a restart should fall back to.
 */
export class FileStateStore {
  private timer: NodeJS.Timeout | null = null
  private pending: (() => PersistedState) | null = null
  private closed = false

  constructor(
    private readonly file: string,
    private readonly debounceMs: number = 400,
  ) {}

  /** Read the snapshot, or undefined when absent, unreadable or malformed. */
  load(): PersistedState | undefined {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return undefined // first run, or the volume is not mounted yet
    }
    try {
      const parsed = JSON.parse(raw) as PersistedState
      if (!parsed || parsed.version !== STATE_VERSION || !Array.isArray(parsed.sessions)) return undefined
      return parsed
    } catch {
      // A corrupt file must not take the relay down — start empty instead.
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
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(snapshot()), { mode: 0o600 })
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
