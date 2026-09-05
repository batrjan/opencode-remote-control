import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { config, opencodeAuthHeader } from './config'

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
