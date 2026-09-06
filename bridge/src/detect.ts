import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { config, opencodeAuthHeader } from './config.js'

const execP = promisify(exec)

/**
 * TCP ports listened on by node/opencode processes (case-insensitive — the
 * desktop app reports its command as "OpenCode"). lsof prints the address as
 * `127.0.0.1:4096`, `*:4096` or `[::1]:4096`, so the port is read after the
 * LAST colon — splitting on the first one dropped every IPv6 listener.
 */
export async function listCandidatePorts(): Promise<number[]> {
  const { stdout } = await execP(
    "lsof -iTCP -sTCP:LISTEN -P 2>/dev/null | awk 'tolower($1) ~ /opencode|node/ {print $9}'",
  )
  const ports: number[] = []
  for (const line of stdout.split('\n')) {
    const address = line.trim()
    if (!address) continue
    const port = Number(address.slice(address.lastIndexOf(':') + 1))
    if (Number.isInteger(port) && port > 0 && !ports.includes(port)) ports.push(port)
  }
  return ports
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

/**
 * Detect an already-running server, or spawn `opencode serve` when none is
 * listening (plain `opencode run`/`--mini` use an in-process server with no
 * external HTTP port, so there is nothing to find). Returns the port and, if
 * we spawned it, the child process so the caller can tie its lifetime to the
 * bridge.
 */
export async function ensureOpenCodeServer(): Promise<{ port: number; spawned?: import('node:child_process').ChildProcess }> {
  try {
    return { port: await detectOpenCodePort() }
  } catch {
    // No running server — start a headless one bound to the current project.
  }
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
