import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { config, opencodeAuthHeader } from './config.js'

const execP = promisify(exec)

/** A TCP listener owned by a node/opencode process. */
export interface Listener {
  port: number
  pid: number
}

/**
 * TCP listeners of node/opencode processes (case-insensitive — the desktop app
 * reports its command as "OpenCode"), with the pid that owns each. lsof prints
 * the address as `127.0.0.1:4096`, `*:4096` or `[::1]:4096`, so the port is
 * read after the LAST colon — splitting on the first one dropped every IPv6
 * listener.
 */
export async function listListeners(): Promise<Listener[]> {
  const { stdout } = await execP(
    "lsof -iTCP -sTCP:LISTEN -P 2>/dev/null | awk 'tolower($1) ~ /opencode|node/ {print $2, $9}'",
  )
  const listeners: Listener[] = []
  for (const line of stdout.split('\n')) {
    const [pidField, address] = line.trim().split(/\s+/)
    if (!pidField || !address) continue
    const pid = Number(pidField)
    const port = Number(address.slice(address.lastIndexOf(':') + 1))
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port <= 0) continue
    // IPv4 and IPv6 sockets of one server are two lines for the same pair.
    if (!listeners.some((l) => l.port === port && l.pid === pid)) listeners.push({ port, pid })
  }
  return listeners
}

/** TCP ports listened on by node/opencode processes, each once. */
export async function listCandidatePorts(): Promise<number[]> {
  return [...new Set((await listListeners()).map((l) => l.port))]
}

/**
 * Find the local OpenCode server port: the first candidate whose
 * /global/health answers { healthy: true } for the env credentials.
 * `candidates` is a test hook — production callers scan the machine.
 */
export async function detectOpenCodePort(candidates?: number[]): Promise<number> {
  for (const port of candidates ?? (await listCandidatePorts())) {
    if (await isHealthy(port)) return port
  }
  throw new Error('opencode not found')
}

export interface EnsureServerOptions {
  /** Listening node/opencode processes — test hook; defaults to listListeners(). */
  listListeners?: () => Promise<Listener[]>
  /**
   * Whether the process behind a listener belongs to a share that is already
   * running on this machine. Such a server is never attached to.
   */
  ownedByShare?: (pid: number) => boolean
}

/**
 * Detect an already-running server, or spawn `opencode serve` when none is
 * listening (plain `opencode run`/`--mini` use an in-process server with no
 * external HTTP port, so there is nothing to find). Returns the port and, if
 * we spawned it, the child process so the caller can tie its lifetime to the
 * bridge.
 */
export async function ensureOpenCodeServer(
  opts: EnsureServerOptions = {},
): Promise<{ port: number; spawned?: import('node:child_process').ChildProcess }> {
  let listeners: Listener[] = []
  try {
    listeners = await (opts.listListeners ?? listListeners)()
  } catch {
    // No lsof (or no awk): nothing to attach to — start our own below.
  }
  for (const { port, pid } of listeners) {
    if (!(await isHealthy(port))) continue
    // A server another share spawned is not the user's: its lifetime belongs to
    // that share, which kills it on every way it ends (stop, the relay revoking
    // it, a signal, its bridge exiting). Attaching to it made this share run on
    // borrowed time — ending the first share cut the second one's viewers off
    // and then ended it too. Start a server of our own instead.
    if (opts.ownedByShare?.(pid)) {
      console.warn(
        `bridge: not attaching to the opencode server on port ${port} (pid ${pid}) — another share started it and ends it with that share; starting a separate one`,
      )
      continue
    }
    return { port }
  }
  // No running server we may use — start a headless one bound to the current project.
  const { spawn } = await import('node:child_process')
  // Capture the server's own logs instead of inheriting our stderr: the TUI
  // plugin reads the bridge's output to show the share URL + code, and the
  // opencode server writes a screenful of INFO/WARN lines that used to bury
  // it (and made every line matching /error/ look like a bridge failure).
  // The tail is kept only to explain a startup failure.
  const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverLogTail = ''
  const keepTail = (chunk: Buffer) => {
    serverLogTail = (serverLogTail + chunk.toString()).slice(-SERVER_LOG_TAIL_CHARS)
  }
  child.stderr?.on('data', keepTail)
  const failure = (message: string) => new Error(serverLogTail ? `${message}\n${serverLogTail.trim()}` : message)
  const port = await new Promise<number>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); reject(failure('opencode serve did not report a port in time')) }
    }, 20_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      keepTail(chunk)
      const m = /http:\/\/[^:\s]+:(\d+)/.exec(chunk.toString())
      if (m && !settled) {
        settled = true
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
    child.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err) } })
    child.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); reject(failure(`opencode serve exited early (${code})`)) } })
  })
  // Wait until it actually answers before returning.
  for (let i = 0; i < 20; i++) {
    if (await isHealthy(port)) return { port, spawned: child }
    await new Promise((r) => setTimeout(r, 250))
  }
  child.kill()
  throw new Error('opencode serve started but never became healthy')
}

/** How much of the spawned server's log to keep for failure messages. */
const SERVER_LOG_TAIL_CHARS = 4000

async function isHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${config.healthPath}`, {
      headers: { Authorization: opencodeAuthHeader() },
      signal: AbortSignal.timeout(config.healthTimeoutMs),
    })
    const data = (await res.json()) as { healthy?: unknown }
    return data.healthy === true
  } catch {
    return false
  }
}
