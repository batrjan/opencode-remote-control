#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Command } from 'commander'
import { config, opencodeAuthHeader } from './config.js'
import { detectOpenCodePort, ensureOpenCodeServer } from './detect.js'
import { OpencodeClient } from './opencode.js'
import { RelayClient, RelayWSClient } from './relay.js'
import { saveSessionState, loadSessionState, clearSessionState, latestSessionState } from './state.js'

/**
 * Bridge CLI and lifecycle: `start` registers the current opencode session
 * with the relay, connects the WS bridge, forwards SSE events, and watches
 * the local opencode server (exits when it dies); `stop` deletes the relay
 * session; `status` probes relay + opencode + session presence.
 *
 * The module doubles as a library (startBridge/stopBridge) for tests; the
 * commander program only runs when the file is executed directly.
 */

export interface StartBridgeOptions {
  /** Explicit opencode port; auto-detected when omitted. */
  port?: number
  /** Explicit session id; the newest session (preferring cwd) when omitted. */
  sessionId?: string
  /** Full opencode base URL — test hook that overrides port detection. */
  opencodeUrl?: string
  /** Watchdog poll interval — test hook; defaults to config.watchdogIntervalMs. */
  healthIntervalMs?: number
  /** Server spawner — test hook; defaults to ensureOpenCodeServer(). */
  serverSpawner?: () => Promise<{ port: number; spawned?: import('node:child_process').ChildProcess }>
}

export interface BridgeHandle {
  session_id: string
  access_code: string
  viewer_url: string
  /** Resolves once the bridge has fully shut down (stop() or watchdog). */
  closed: Promise<void>
  /** Stop the watchdog, close the WS, and delete the relay session. Idempotent. */
  stop(): Promise<void>
}

interface OpencodeSessionInfo {
  id: string
  directory?: string
  title?: string
  parentID?: string
  time?: { created?: number }
}

export async function startBridge(
  relayUrl: string,
  apiKey: string | undefined,
  opts: StartBridgeOptions = {},
): Promise<BridgeHandle> {
  // When no opencode server is listening (plain console runs use an
  // in-process server with no HTTP port), spawn `opencode serve` ourselves so
  // remote control works without the TUI. The spawned server is tied to the
  // bridge's lifetime below.
  let spawnedServer: import('node:child_process').ChildProcess | undefined
  let resolvedPort: number
  if (opts.opencodeUrl) {
    resolvedPort = 0 // unused; url given directly
  } else if (opts.port !== undefined) {
    resolvedPort = opts.port
  } else {
    const ensured = await (opts.serverSpawner ?? ensureOpenCodeServer)()
    resolvedPort = ensured.port
    spawnedServer = ensured.spawned
  }
  const opencodeUrl = opts.opencodeUrl ?? `http://127.0.0.1:${resolvedPort}`
  const opencode = new OpencodeClient(
    opencodeUrl,
    process.env.OPENCODE_SERVER_USERNAME ?? 'opencode',
    process.env.OPENCODE_SERVER_PASSWORD ?? '',
  )
  // With an explicit --session-id we still need the session's OWN directory:
  // it is what the relay pins every proxied request to and what scopes the
  // event stream. Falling back to process.cwd() pointed both at whatever
  // folder the bridge happened to start in.
  const picked =
    opts.sessionId === undefined ? await pickSession(opencode) : await fetchSession(opencode, opts.sessionId)
  const session_id = opts.sessionId ?? picked!.id
  const relay = new RelayClient(relayUrl, apiKey)
  const { access_code, bridge_token, viewer_url } = await relay.createSession(
    session_id,
    picked?.directory ?? process.cwd(),
    picked?.title ?? '',
  )
  // Persist the owner token so `stop` (even from another shell) can delete
  // the session later. 0600 perms; cleared on stop.
  // The pid lets `stop` (run from the TUI plugin or another shell) terminate
  // this long-running process — deleting the relay session alone left the
  // bridge and the `opencode serve` it spawned running forever.
  saveSessionState({
    session_id,
    access_code,
    bridge_token,
    relay: relayUrl,
    started_at: Date.now(),
    pid: process.pid,
  })
  const ws = new RelayWSClient(relayUrl, opencode)
  try {
    await ws.connect(session_id, bridge_token, picked?.directory)
    await ws.startEventForwarding()
  } catch (err) {
    // Never leave an orphaned session behind when the WS/SSE setup fails.
    ws.close()
    await relay.deleteSession(session_id, bridge_token).catch(() => {})
    clearSessionState(session_id)
    throw err
  }

  const killSpawnedServer = () => {
    if (spawnedServer && spawnedServer.exitCode === null && !spawnedServer.killed) spawnedServer.kill()
  }
  // Last resort: never leave the spawned server behind if this process dies
  // for a reason that does not go through stop().
  process.on('exit', killSpawnedServer)

  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    clearInterval(watchdog)
    process.off('exit', killSpawnedServer)
    ws.close()
    // If we spawned the opencode server ourselves (the TUI has no HTTP port,
    // so this is the normal path), stop it too — the share's lifetime owns
    // the server it created.
    killSpawnedServer()
    try {
      await relay.deleteSession(session_id, bridge_token)
    } catch {
      // Best effort: the relay may itself be unreachable at shutdown.
    }
    clearSessionState(session_id)
    resolveClosed()
  }
  // The relay only closes us on purpose when the session is gone (stopped
  // elsewhere, or credentials revoked) — there is nothing left to reconnect
  // to, so shut down instead of retrying forever.
  ws.onFatal = () => void stop()
  // Watchdog: opencode gone (process exited / port closed) → notify the
  // relay (revokes code + tokens) and shut down.
  const watchdog = setInterval(() => {
    void (async () => {
      if (!(await opencodeHealthy(opencodeUrl))) await stop()
    })()
  }, opts.healthIntervalMs ?? config.watchdogIntervalMs)
  watchdog.unref() // never keep the process alive just for the watchdog

  return { session_id, access_code, viewer_url, closed, stop }
}

export async function stopBridge(
  relayUrl: string,
  sessionId: string,
  apiKey?: string,
): Promise<void> {
  // Deleting a session requires its OWN bridge_token (never a shared key) —
  // read it from the state `start` persisted.
  const state = loadSessionState(sessionId)
  if (!state) {
    // Nothing to do: without the owner token we cannot (and should not)
    // delete the session. Treat as already-stopped (idempotent).
    return
  }
  const status = await new RelayClient(relayUrl, apiKey).deleteSession(sessionId, state.bridge_token)
  // 404 means the session is already gone — stop stays idempotent.
  if (status !== 204 && status !== 404) {
    throw new Error(`relay deleteSession failed: ${status}`)
  }
  clearSessionState(sessionId)
  terminateBridgeProcess(state.pid, state.started_at)
}

/** What the OS reports about a live pid: its command line and, when `ps`
 * supports `lstart`, when that process started (epoch ms). */
export interface ProcessSnapshot {
  command: string
  startedAt?: number
}

/**
 * Command lines that belong to a bridge. Covers every way the CLI is launched:
 * the prebuilt plugin bundle (`plugin/bridge/remote-control-bridge.cjs`), the
 * skill layout install.sh writes (`~/.agents/skills/remote-control/bin/index.js`),
 * a repo checkout (`bridge/dist/index.js`, `bridge/src/index.ts`) and the npm
 * bin shim (`node_modules/.bin/bridge`).
 */
const BRIDGE_ENTRY_RE =
  /(remote-control-bridge(\.cjs)?|remote-control[/\\]bin[/\\]index\.(js|cjs|mjs)|bridge[/\\](dist[/\\])?index\.(js|cjs|mjs|ts)|[/\\]\.bin[/\\]bridge(\s|$))/
/** The interpreter a bridge always runs under. */
const NODE_EXEC_RE = /(^|[/\\])(node|nodejs|node\d+(\.\d+)*|bun|deno|tsx|ts-node)(\.exe)?$/

/**
 * How much later than the recorded `started_at` a process may have started and
 * still be the bridge that wrote it. The state file is written AFTER the
 * process is up (registration talks to the relay first), so the bridge's own
 * start time is always EARLIER than `started_at`; a process that appeared
 * after it is a different one wearing a recycled pid. The slack absorbs a slow
 * registration, ps's one-second resolution and clock jitter.
 */
const PID_START_SLACK_MS = 120_000

/** Read a pid's command line (and start time when available); null if the pid
 * is gone or `ps` cannot answer. Never throws. */
function describeProcess(pid: number): ProcessSnapshot | null {
  const ps = (format: string): string | null => {
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', format], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const line = out.split('\n')[0]?.trim() ?? ''
      return line.length > 0 ? line : null
    } catch {
      // No such pid, `ps` missing, or a format this ps does not know.
      return null
    }
  }
  // One call for both fields. `lstart` is a fixed 5-token date ("Thu Sep 11
  // 09:12:13 2026") on both macOS and Linux, so the command is everything
  // after it. A ps build that rejects `lstart` fails the whole call, hence the
  // command-only retry — losing the start time must never lose the command.
  const combined = ps('lstart=,command=')
  if (combined) {
    const m = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S.*)$/.exec(combined)
    const started = m ? Date.parse(m[1]!) : NaN
    if (m && Number.isFinite(started)) return { command: m[2]!, startedAt: started }
  }
  const command = ps('command=')
  return command ? { command } : null
}

/** Whether a command line is a node process running the bridge entry point. */
function isBridgeCommand(command: string): boolean {
  const exec = command.trim().split(/\s+/)[0] ?? ''
  return NODE_EXEC_RE.test(exec) && BRIDGE_ENTRY_RE.test(command)
}

/** Why this pid must not be signalled, or null when it is safe to. */
function refuseToSignal(snapshot: ProcessSnapshot | null, startedAt?: number): string | null {
  if (!snapshot) return 'no such process (already gone)'
  if (!isBridgeCommand(snapshot.command)) {
    return `pid now belongs to an unrelated process: ${snapshot.command.slice(0, 120)}`
  }
  if (startedAt !== undefined && snapshot.startedAt !== undefined && snapshot.startedAt > startedAt + PID_START_SLACK_MS) {
    return 'process started after this share was registered (recycled pid)'
  }
  return null
}

/**
 * Signal the long-running `start` process so it shuts down (its SIGTERM
 * handler closes the WS and kills the `opencode serve` it spawned). Without
 * this, `stop` only removed the relay session and left both processes — and
 * the spawned server's port — behind.
 *
 * The pid comes from a state file that outlives a bridge killed with -9, a
 * panic or a reboot, and the OS recycles pids — so `stop` used to SIGTERM
 * whatever stranger had inherited the number. Verify the pid still runs a
 * bridge (command line, corroborated by the process's own start time) before
 * signalling. Never signals the caller itself (the library path runs stop
 * inside the bridge process), and never throws: `stop` stays idempotent even
 * when `ps` is unavailable.
 *
 * `inspect` is injectable so the check itself can be tested deterministically.
 */
export function terminateBridgeProcess(
  pid: number | undefined,
  startedAt?: number,
  inspect: (pid: number) => ProcessSnapshot | null = describeProcess,
): void {
  if (!pid || pid === process.pid) return
  let snapshot: ProcessSnapshot | null = null
  try {
    snapshot = inspect(pid)
  } catch {
    // An unusable lookup must not turn `stop` into a crash — and must not turn
    // into a blind kill either: fall through with no evidence, which refuses.
    snapshot = null
  }
  const refusal = refuseToSignal(snapshot, startedAt)
  if (refusal) {
    // Silence here would be indistinguishable from a successful stop, and the
    // stale-state case is exactly when the user wonders why nothing happened.
    console.warn(`bridge stop: not signalling pid ${pid} — ${refusal}`)
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Raced with its own exit (ESRCH) or not ours (EPERM) — nothing to clean up.
  }
}

/** Newest ROOT session in the CURRENT working directory. Subagent sessions
 * have a parentID and are never what the user is looking at. We query with
 * `?directory=` because the opencode instance (e.g. the desktop app) hosts
 * many projects at once — an unfiltered list would pick a session from an
 * unrelated project. */
async function pickSession(opencode: OpencodeClient): Promise<OpencodeSessionInfo> {
  const cwd = process.cwd()
  const sessions = (await opencode.getSessions(cwd)) as OpencodeSessionInfo[]
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new Error(`no opencode sessions found in ${cwd}`)
  }
  const roots = sessions.filter((s) => !s.parentID)
  const candidates = roots.length > 0 ? roots : sessions
  return candidates.sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))[0]!
}

/**
 * Session detail for an explicitly requested id. Best effort: an unreachable
 * or unknown session leaves the caller on its previous fallbacks rather than
 * failing the share.
 */
async function fetchSession(
  opencode: OpencodeClient,
  sessionId: string,
): Promise<OpencodeSessionInfo | undefined> {
  try {
    const out = await opencode.request('GET', `/session/${encodeURIComponent(sessionId)}`)
    if (out.status !== 200) return undefined
    const info = JSON.parse(out.body) as OpencodeSessionInfo
    return info && typeof info.id === 'string' ? info : undefined
  } catch {
    return undefined
  }
}

async function opencodeHealthy(opencodeUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${opencodeUrl}${config.healthPath}`, {
      headers: { Authorization: opencodeAuthHeader() },
      signal: AbortSignal.timeout(config.healthTimeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

/* ---------------------------------- CLI ---------------------------------- */

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Resolve the session id: explicit flag wins, else the most recent state
 * written by `start`. */
function resolveSessionId(flag: string | undefined): string | undefined {
  return flag ?? latestSessionState()?.session_id
}

const program = new Command()
program.name('bridge').description('OpenCode remote-control bridge')

program
  .command('start')
  .description('Register this session with the relay and serve proxy requests until stopped')
  .option('--relay <url>', 'relay base URL', config.defaultRelayUrl)
  .option('--api-key <key>', 'relay API key (optional; the public relay does not need it)')
  .option('--port <port>', 'opencode port (auto-detected when omitted)')
  .option('--session-id <id>', 'opencode session id (newest session when omitted)')
  .action(async (opts: { relay: string; apiKey?: string; port?: string; sessionId?: string }) => {
    const port = opts.port === undefined ? undefined : Number(opts.port)
    if (port !== undefined && !Number.isInteger(port)) {
      console.error('error: --port must be an integer')
      process.exitCode = 1
      return
    }
    let handle: BridgeHandle
    try {
      handle = await startBridge(opts.relay, opts.apiKey, { port, sessionId: opts.sessionId })
    } catch (err) {
      console.error(`bridge start failed: ${errorMessage(err)}`)
      process.exitCode = 1
      return
    }
    // Output contract: exactly two lines — the session link and the code.
    const relayBase = opts.relay.replace(/\/+$/, '')
    console.log(`${relayBase}${handle.viewer_url}`)
    console.log(`CODE: ${handle.access_code}`)
    const onSignal = () => void handle.stop()
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    process.on('SIGHUP', onSignal)
    await handle.closed
    console.log('Remote control stopped.')
  })

program
  .command('stop')
  .description('End a remote-control session on the relay')
  .option('--relay <url>', 'relay base URL', config.defaultRelayUrl)
  .option('--api-key <key>', 'relay API key (optional)')
  .option('--session-id <id>', 'opencode session id (latest started when omitted)')
  .action(async (opts: { relay: string; apiKey?: string; sessionId?: string }) => {
    const sessionId = resolveSessionId(opts.sessionId)
    if (!sessionId) {
      console.error('error: no session id (pass --session-id or start a share first)')
      process.exitCode = 1
      return
    }
    try {
      await stopBridge(opts.relay, sessionId, opts.apiKey)
      console.log('Remote control stopped.')
    } catch (err) {
      console.error(`bridge stop failed: ${errorMessage(err)}`)
      process.exitCode = 1
    }
  })

program
  .command('status')
  .description('Probe relay health, local opencode detection, and session presence')
  .option('--relay <url>', 'relay base URL', config.defaultRelayUrl)
  .option('--api-key <key>', 'relay API key (optional)')
  .option('--session-id <id>', 'opencode session id (latest started when omitted)')
  .action(async (opts: { relay: string; apiKey?: string; sessionId?: string }) => {
    let ok = true
    try {
      const res = await fetch(`${opts.relay}/health`, { signal: AbortSignal.timeout(5000) })
      console.log(`relay: ${res.ok ? 'ok' : `HTTP ${res.status}`} (${opts.relay})`)
      if (!res.ok) ok = false
    } catch {
      console.log(`relay: unreachable (${opts.relay})`)
      ok = false
    }
    try {
      const port = await detectOpenCodePort()
      console.log(`opencode: detected on port ${port}`)
    } catch {
      console.log('opencode: not detected')
      ok = false
    }
    const sessionId = resolveSessionId(opts.sessionId)
    if (sessionId) {
      // Pass our own bridge_token so the relay returns the owner-only fields
      // (directory, title) it withholds from the public presence view.
      const ownerToken = loadSessionState(sessionId)?.bridge_token
      const { status, body } = await new RelayClient(opts.relay, opts.apiKey).getSession(sessionId, ownerToken)
      if (status === 404) {
        console.log(`session ${sessionId}: not found`)
        ok = false
      } else if (status !== 200 || !body) {
        console.log(`session ${sessionId}: HTTP ${status}`)
        ok = false
      } else {
        const ageMs = Date.now() - body.created_at
        const age = formatDuration(ageMs)
        console.log(`session ${sessionId}: ${body.status}`)
        console.log(`  bridge: ${body.bridge_connected ? 'connected' : 'disconnected'}`)
        console.log(`  viewers: ${body.viewer_count}`)
        console.log(`  alive: ${age}`)
        if (body.title !== undefined) console.log(`  title: ${body.title || '(untitled)'}`)
        if (body.directory !== undefined) console.log(`  directory: ${body.directory}`)
      }
    }
    if (!ok) process.exitCode = 1
  })

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h`
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

// Run the CLI only when executed directly (not when imported by tests).
// A bundled single-file build (esbuild CJS) has a different argv[1] relation
// to import.meta.url, so always run when this file is the process entrypoint.
const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href ||
    process.argv[1].endsWith('remote-control-bridge.cjs') ||
    process.argv[1].endsWith('bridge/index.cjs'))
if (invokedDirectly) {
  program.parseAsync(process.argv).catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
