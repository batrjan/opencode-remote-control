import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'node:fs'
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

/** Most recent saved session (for stop/status when the id is not passed). */
export function latestSessionState(): SessionState | undefined {
  try {
    const dir = stateDir()
    if (!existsSync(dir)) return undefined
    const files = readdirSync(dir).filter((f: string) => f.endsWith('.json'))
    let best: SessionState | undefined
    for (const f of files) {
      try {
        const s = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as SessionState
        if (!best || s.started_at > best.started_at) best = s
      } catch {
        // skip unreadable entry
      }
    }
    return best
  } catch {
    return undefined
  }
}
