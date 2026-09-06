import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { config, opencodeAuthHeader } from './config.js'

const execP = promisify(exec)

/**
 * Find the local OpenCode server port: list TCP listeners owned by
 * node/opencode processes (case-insensitive — the desktop app reports its
 * command as "OpenCode") and return the first port whose /global/health
 * answers { healthy: true } for the env credentials.
 */
export async function detectOpenCodePort(): Promise<number> {
  const { stdout } = await execP(
    "lsof -iTCP -sTCP:LISTEN -P 2>/dev/null | awk 'tolower($1) ~ /opencode|node/ {print $9}'",
  )
  for (const line of stdout.split('\n')) {
    const port = Number(line.split(':')[1])
    if (port && (await isHealthy(port))) return port
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
  const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const port = await new Promise<number>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); reject(new Error('opencode serve did not report a port in time')) }
    }, 20_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      const m = /http:\/\/[^:\s]+:(\d+)/.exec(chunk.toString())
      if (m && !settled) {
        settled = true
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
    child.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err) } })
    child.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`opencode serve exited early (${code})`)) } })
  })
  // Wait until it actually answers before returning.
  for (let i = 0; i < 20; i++) {
    if (await isHealthy(port)) return { port, spawned: child }
    await new Promise((r) => setTimeout(r, 250))
  }
  child.kill()
  throw new Error('opencode serve started but never became healthy')
}

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
