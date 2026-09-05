/**
 * Central bridge configuration. Secrets come from the environment and are
 * read lazily (at call time) so tests and CLI flag overrides can set them
 * after module load.
 */
export const config = {
  /** Path probed on candidate OpenCode ports during auto-detection. */
  healthPath: '/global/health',
  /** Per-port health probe timeout; keeps detection fast with stale listeners. */
  healthTimeoutMs: 1500,
  /** Public relay the bridge registers sessions with (overridable via CLI). */
  defaultRelayUrl: 'https://opencode.b4tr.net',
  /** Watchdog interval for polling the local opencode server while running. */
  watchdogIntervalMs: 10_000,
} as const

/** HTTP Basic header value for an explicit credential pair. */
export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

/**
 * Basic header for the local OpenCode server, from
 * OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD.
 * OpenCode's default server username is 'opencode'.
 */
export function opencodeAuthHeader(): string {
  return basicAuthHeader(
    process.env.OPENCODE_SERVER_USERNAME ?? 'opencode',
    process.env.OPENCODE_SERVER_PASSWORD ?? '',
  )
}
