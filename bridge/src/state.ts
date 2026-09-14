import { createHmac, randomBytes } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  readdirSync,
  linkSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Local per-session state: the bridge_token that owns a registered session.
 *
 * The relay's DELETE requires the session's own bridge_token (never a shared
 * key), so the token must survive across CLI invocations: `start` writes it,
 * `stop` reads it back. Stored under the skill dir with 0600 perms — it is a
 * live credential for the share's lifetime, deleted on stop.
 */
export interface SessionState {
  session_id: string
  access_code: string
  bridge_token: string
  relay: string
  started_at: number
  /** PID of the long-running `start` process, so `stop` can terminate it.
   * Absent in state written by older versions. */
  pid?: number
  /**
   * PID of the `opencode serve` this bridge spawned, when it spawned one.
   *
   * The bridge kills its own child on the way out, but only along paths that
   * run JavaScript: a SIGKILL, a panic or a reboot skip that handler and leave
   * the server running forever, holding its port. The next `start` then detects
   * that stale server and attaches to it — a server belonging to a share that
   * ended, possibly for another project. Recording the pid lets `stop` finish
   * the job even when the bridge never got to. Absent when the bridge attached
   * to a server it did not start (that one is not ours to kill).
   */
  server_pid?: number
}

function stateDir(): string {
  return path.join(homedir(), '.agents', 'skills', 'remote-control', 'state')
}

function statePath(sessionId: string): string {
  return path.join(stateDir(), `${sessionId}.json`)
}

export function saveSessionState(state: SessionState): void {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  writeFileSync(statePath(state.session_id), JSON.stringify(state, null, 2), { mode: 0o600 })
}

export function loadSessionState(sessionId: string): SessionState | undefined {
  try {
    return JSON.parse(readFileSync(statePath(sessionId), 'utf8')) as SessionState
  } catch {
    return undefined
  }
}

export function clearSessionState(sessionId: string): void {
  try {
    unlinkSync(statePath(sessionId))
  } catch {
    // already gone
  }
}

/**
 * Remove the state of `sessionId` only while it still holds `bridgeToken`: the
 * share that token belongs to is ending, and the file is its to remove.
 *
 * The file is named after the session, not the share, and a start only sees a
 * share this install runs once that share has written it — after registering.
 * Two overlapping starts of one session can therefore both register, the relay
 * letting the later one replace the earlier (same owner_key), and the later
 * one's state is then already on disk when the earlier one tears down. Removing
 * the file by name there took the live share's token with it: `stop` answered
 * "not shared from this machine" and nothing local could end that share.
 */
export function clearOwnSessionState(sessionId: string, bridgeToken: string): void {
  if (loadSessionState(sessionId)?.bridge_token === bridgeToken) clearSessionState(sessionId)
}

/**
 * The owner_key this install registers `sessionId` with on the relay at
 * `relayUrl`: HMAC-SHA256 of the relay's origin and the id under the install
 * secret (see loadOrCreateOwnerSecret), base64url.
 *
 * The share link names the session id, and the owner registers that same id
 * again every time the conversation is shared. The relay used to hand a freed
 * id to whoever registered it first, so anyone holding an old link could take
 * it the moment the owner stopped, and the owner's next start failed with a
 * 409 it had no token to clear. The relay now reserves an id for the key it
 * was registered with, and lets that key replace a live registration of it.
 *
 * Derived per id, so the key sent for one share proves nothing about any
 * other, and per relay, because every relay the bridge registers with reads
 * the key in the clear: a self-hosted one, or a mistyped address. Keyed on the
 * id alone, whoever ran that relay could replay it on the public one and take
 * over the owner's live share there (code, viewers and bridge revoked, fresh
 * credentials handed to them) or claim its id. The origin, not the URL as
 * typed: a trailing slash, a default port or credentials in the URL name the
 * same relay and must not cost the owner its reservation. The secret itself
 * never leaves this machine.
 */
export function ownerKey(relayUrl: string, sessionId: string): string {
  let url: URL | undefined
  try {
    url = new URL(relayUrl)
  } catch {
    url = undefined
  }
  // Other schemes have no relay to register with (fetch refuses them), and
  // some share one opaque origin ('null'): fail before anything is sent.
  if (url?.protocol !== 'http:' && url?.protocol !== 'https:') {
    throw new Error('relay URL must be an http:// or https:// URL')
  }
  return createHmac('sha256', loadOrCreateOwnerSecret()).update(`${url.origin}\n${sessionId}`).digest('base64url')
}

const OWNER_SECRET_BYTES = 32

function ownerSecretPath(): string {
  // Not a .json file: latestSessionState and the plugin read every *.json here
  // as a share.
  return path.join(stateDir(), 'owner.key')
}

/**
 * The install secret behind every owner_key: 32 random bytes, created on first
 * use, 0600. Unlike a session state it is never deleted — losing it only
 * means the relay keeps this install's ended shares reserved until their
 * claims expire.
 *
 * Written to a temp file and hard-linked into place, which fails when the
 * file exists: two starts racing to create it both end up with whichever
 * secret landed first, and neither ever reads a half-written one.
 */
export function loadOrCreateOwnerSecret(): Buffer {
  const file = ownerSecretPath()
  const existing = readOwnerSecret(file)
  if (existing) return existing
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  const secret = randomBytes(OWNER_SECRET_BYTES)
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, secret, { mode: 0o600 })
  try {
    linkSync(tmp, file)
    return secret
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const raced = readOwnerSecret(file)
    if (raced) return raced
    // A file of the wrong size (truncated, edited by hand) proves nothing:
    // replace it rather than fail every start from now on.
    renameSync(tmp, file)
    return secret
  } finally {
    rmSync(tmp, { force: true })
  }
}

function readOwnerSecret(file: string): Buffer | undefined {
  try {
    const secret = readFileSync(file)
    return secret.length === OWNER_SECRET_BYTES ? secret : undefined
  } catch {
    return undefined
  }
}

/** Every saved session state, in no particular order. Unreadable entries are skipped; never throws. */
export function listSessionStates(): SessionState[] {
  try {
    const dir = stateDir()
    if (!existsSync(dir)) return []
    const files = readdirSync(dir).filter((f: string) => f.endsWith('.json'))
    const states: SessionState[] = []
    for (const f of files) {
      try {
        const s = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as SessionState | null
        if (s && typeof s === 'object') states.push(s)
      } catch {
        // skip unreadable entry
      }
    }
    return states
  } catch {
    return []
  }
}

/** Most recent saved session (for stop/status when the id is not passed). */
export function latestSessionState(): SessionState | undefined {
  let best: SessionState | undefined
  for (const s of listSessionStates()) {
    if (!best || s.started_at > best.started_at) best = s
  }
  return best
}
