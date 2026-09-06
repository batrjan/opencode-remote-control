#!/usr/bin/env node
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
  const picked = opts.sessionId === undefined ? await pickSession(opencode) : undefined
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
    await ws.connect(session_id, bridge_token)
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
  terminateBridgeProcess(state.pid)
}

/**
 * Signal the long-running `start` process so it shuts down (its SIGTERM
 * handler closes the WS and kills the `opencode serve` it spawned). Without
 * this, `stop` only removed the relay session and left both processes — and
 * the spawned server's port — behind. Never signals the caller itself (the
 * library path runs stop inside the bridge process) and tolerates a stale pid.
 */
function terminateBridgeProcess(pid: number | undefined): void {
  if (!pid || pid === process.pid) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Already gone (ESRCH) or not ours (EPERM) — nothing to clean up.
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
      const { status, body } = await new RelayClient(opts.relay, opts.apiKey).getSession(sessionId)
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
        console.log(`  title: ${body.title || '(untitled)'}`)
        console.log(`  directory: ${body.directory}`)
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
