#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Command } from 'commander'
import { config, opencodeAuthHeader } from './config.js'
import { detectOpenCodePort } from './detect.js'
import { OpencodeClient } from './opencode.js'
import { RelayClient, RelayWSClient } from './relay.js'

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
  time?: { created?: number }
}

export async function startBridge(
  relayUrl: string,
  apiKey: string,
  opts: StartBridgeOptions = {},
): Promise<BridgeHandle> {
  const opencodeUrl =
    opts.opencodeUrl ?? `http://127.0.0.1:${opts.port ?? (await detectOpenCodePort())}`
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
  const ws = new RelayWSClient(relayUrl, opencode)
  try {
    await ws.connect(session_id, bridge_token)
    await ws.startEventForwarding()
  } catch (err) {
    // Never leave an orphaned session behind when the WS/SSE setup fails.
    ws.close()
    await relay.deleteSession(session_id).catch(() => {})
    throw err
  }

  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    clearInterval(watchdog)
    ws.close()
    try {
      await relay.deleteSession(session_id)
    } catch {
      // Best effort: the relay may itself be unreachable at shutdown.
    }
    resolveClosed()
  }
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
  apiKey: string,
): Promise<void> {
  const status = await new RelayClient(relayUrl, apiKey).deleteSession(sessionId)
  // 404 means the session is already gone — stop stays idempotent.
  if (status !== 204 && status !== 404) {
    throw new Error(`relay deleteSession failed: ${status}`)
  }
}

/** Newest session, preferring ones whose directory matches the cwd. */
async function pickSession(opencode: OpencodeClient): Promise<OpencodeSessionInfo> {
  const sessions = (await opencode.getSessions()) as OpencodeSessionInfo[]
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new Error('no opencode sessions found')
  }
  const cwd = process.cwd()
  const inCwd = sessions.filter((s) => s.directory === cwd)
  const pool = inCwd.length > 0 ? inCwd : sessions
  return pool.sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))[0]!
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

function requireApiKey(flag: string | undefined): string | undefined {
  return flag ?? process.env.RELAY_API_KEY ?? undefined
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const program = new Command()
program.name('bridge').description('OpenCode remote-control bridge')

program
  .command('start')
  .description('Register this session with the relay and serve proxy requests until stopped')
  .option('--relay <url>', 'relay base URL', config.defaultRelayUrl)
  .option('--api-key <key>', 'relay API key (or RELAY_API_KEY env)')
  .option('--port <port>', 'opencode port (auto-detected when omitted)')
  .option('--session-id <id>', 'opencode session id (newest session when omitted)')
  .action(async (opts: { relay: string; apiKey?: string; port?: string; sessionId?: string }) => {
    const apiKey = requireApiKey(opts.apiKey)
    if (!apiKey) {
      console.error('error: --api-key or RELAY_API_KEY is required')
      process.exitCode = 1
      return
    }
    const port = opts.port === undefined ? undefined : Number(opts.port)
    if (port !== undefined && !Number.isInteger(port)) {
      console.error('error: --port must be an integer')
      process.exitCode = 1
      return
    }
    let handle: BridgeHandle
    try {
      handle = await startBridge(opts.relay, apiKey, { port, sessionId: opts.sessionId })
    } catch (err) {
      console.error(`bridge start failed: ${errorMessage(err)}`)
      process.exitCode = 1
      return
    }
    console.log('Remote control started.')
    console.log(`Access code: ${handle.access_code}`)
    console.log(`Viewer URL: ${opts.relay}${handle.viewer_url}`)
    console.log(`Session: ${handle.session_id}`)
    const onSignal = () => void handle.stop()
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    await handle.closed
    console.log('Remote control stopped.')
  })

program
  .command('stop')
  .description('End a remote-control session on the relay')
  .option('--relay <url>', 'relay base URL', config.defaultRelayUrl)
  .option('--api-key <key>', 'relay API key (or RELAY_API_KEY env)')
  .requiredOption('--session-id <id>', 'opencode session id')
  .action(async (opts: { relay: string; apiKey?: string; sessionId: string }) => {
    const apiKey = requireApiKey(opts.apiKey)
    if (!apiKey) {
      console.error('error: --api-key or RELAY_API_KEY is required')
      process.exitCode = 1
      return
    }
    try {
      await stopBridge(opts.relay, opts.sessionId, apiKey)
      console.log(`Remote control stopped for session ${opts.sessionId}.`)
    } catch (err) {
      console.error(`bridge stop failed: ${errorMessage(err)}`)
      process.exitCode = 1
    }
  })

program
  .command('status')
  .description('Probe relay health, local opencode detection, and session presence')
  .option('--relay <url>', 'relay base URL', config.defaultRelayUrl)
  .option('--api-key <key>', 'relay API key (or RELAY_API_KEY env)')
  .option('--session-id <id>', 'opencode session id to check on the relay')
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
    if (opts.sessionId) {
      const apiKey = requireApiKey(opts.apiKey)
      if (!apiKey) {
        console.log('session: skipped (--api-key or RELAY_API_KEY required)')
        ok = false
      } else {
        const status = await new RelayClient(opts.relay, apiKey).getSession(opts.sessionId)
        console.log(
          `session ${opts.sessionId}: ${
            status === 200 ? 'registered' : status === 404 ? 'not found' : `HTTP ${status}`
          }`,
        )
        if (status !== 200) ok = false
      }
    }
    if (!ok) process.exitCode = 1
  })

// Run the CLI only when executed directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
if (invokedDirectly) {
  program.parseAsync(process.argv).catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
