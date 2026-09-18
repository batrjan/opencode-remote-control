import { createHmac, randomBytes } from 'node:crypto'
import {
  chmodSync,
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
  /**
   * The access code the relay minted for this share.
   *
   * Kept for the same reason as the bridge_token, and used the same way: a
   * start that takes back a share this install left behind (its opencode was
   * SIGKILLed, the machine rebooted) presents it, and the relay then CONTINUES
   * that share — same code, same viewers — instead of minting a new code and
   * sending every viewer's tab back to a code-entry page it can no longer get
   * past. It has always been written here, and it is already in bridge.log
   * beside the viewer URL, so it is no new class of secret on this disk; what
   * is new is that a start reads it back.
   */
  access_code: string
  bridge_token: string
  relay: string
  started_at: number
  /** PID of the long-running `start` process, so `stop` can terminate it.
   * Absent in state written by older versions. */
  pid?: number
  /**
   * Set by a start that registered its share but never got its bridge up, and
   * left that share registered because it had RESUMED one that was already
   * running with viewers in it (see startBridge). It says that `pid` is not a
   * bridge serving this share: that process is on its way out, and without
   * this the next start would read a live pid — its own, for a caller that
   * embeds the library — and refuse the share as one this machine is already
   * sharing, which is the one thing a retry must not hit.
   *
   * Never written by a start that succeeded; the state that start writes is a
   * plain one, and this is gone with it.
   */
  bridge_gone?: true
  /**
   * PID of the `opencode serve` this bridge spawned, when it spawned one.
   *
   * The bridge kills its own child on the way out, but only along paths that
   * run JavaScript: a SIGKILL, a panic or a reboot skip that handler and leave
   * the server running forever, holding its port. The next `start` then detects
   * that stale server and attaches to it — a server belonging to a share that
   * ended, possibly for another project. Recording the pid lets `stop` finish
   * the job even when the bridge never got to. Also the server a dead share of
   * the same session spawned, when a start kept it running and took it over.
   * Absent when the bridge attached to a server no share started (that one is
   * not ours to kill).
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
  const file = statePath(state.session_id)
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 })
  // `mode` above applies only when writeFileSync CREATES the file, so a state
  // file that was once readable by others — a restored backup, a hand edit, a
  // umask experiment — kept that mode through every rewrite, carrying the
  // bridge_token and the access code with it. Chmod every write instead.
  // Best effort: a filesystem with no POSIX modes (a Windows volume) must not
  // fail a start that has already registered its share.
  try {
    chmodSync(file, 0o600)
  } catch {
    // nothing to enforce here
  }
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
 * Record on `sessionId`'s state, only while it still holds `bridgeToken`, that
 * no bridge of this install is serving the share any more (see
 * SessionState.bridge_gone). The token stays — it is what `stop` needs to end
 * the share that is still registered — and so does the code, which is what the
 * next start presents to take that share back.
 *
 * By token, like clearOwnSessionState and for the same reason: a concurrent
 * start of this session may have registered and written its own state by now,
 * and that live share must not be marked bridgeless by a start that failed.
 */
export function markOwnSessionBridgeGone(sessionId: string, bridgeToken: string): void {
  const state = loadSessionState(sessionId)
  if (!state || state.bridge_token !== bridgeToken) return
  saveSessionState({ ...state, bridge_gone: true })
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
