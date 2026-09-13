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
  /** Watchdog interval for polling the local opencode server (and the owner process) while running. */
  watchdogIntervalMs: 10_000,
} as const

/**
 * Keep-alive tuning for the relay WebSocket. On a weak network the socket
 * often does not close: it goes half-open, so both ends keep believing the
 * link is up while nothing crosses it. The bridge therefore proves the link
 * with its own pings and re-dials when they stop being answered.
 *
 * Read lazily from the environment so tests can shrink them.
 */
export function wsPingIntervalMs(): number {
  return Number(process.env.REMOTE_CONTROL_WS_PING_INTERVAL_MS ?? 20_000)
}

/**
 * Watchdog poll interval (opencode health + owner process). Defaults to
 * config.watchdogIntervalMs; the env override exists so a test that drives the
 * real bundle through the plugin does not wait ten seconds per tick.
 */
export function watchdogIntervalMs(): number {
  const v = Number(process.env.REMOTE_CONTROL_WATCHDOG_INTERVAL_MS)
  return Number.isFinite(v) && v > 0 ? v : config.watchdogIntervalMs
}

/**
 * Deadline for the relay WebSocket's opening handshake: DNS, TCP connect, TLS
 * and the HTTP upgrade. ws applies it as an idle timeout on the socket, so it
 * only fires once nothing has crossed it for this long. The whole handshake is
 * a few kilobytes, which even a 0.7 Mbit/s uplink moves in well under a
 * second; it stays below the plugin's 30 s wait for a starting bridge, so a
 * stalled first dial fails and cleans up before the plugin gives up on it.
 */
export function wsHandshakeTimeoutMs(): number {
  const v = Number(process.env.REMOTE_CONTROL_WS_HANDSHAKE_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 15_000
}

/** First reconnect delay; doubles per attempt up to reconnectMaxMs. */
export function reconnectBaseMs(): number {
  return Number(process.env.REMOTE_CONTROL_RECONNECT_BASE_MS ?? 1_000)
}

/** Ceiling for the reconnect backoff — retries never get slower than this. */
export function reconnectMaxMs(): number {
  return Number(process.env.REMOTE_CONTROL_RECONNECT_MAX_MS ?? 30_000)
}

/** Delay before re-subscribing to opencode's event stream after it ends. */
export function eventRetryMs(): number {
  return Number(process.env.REMOTE_CONTROL_EVENT_RETRY_MS ?? 1_000)
}

/**
 * Relay-socket send queue above which event forwarding stops reading from
 * opencode until the queue drains. Sized for a slow uplink: at 2 Mbit/s one
 * MiB is about four seconds — the most a viewer's request waits behind events.
 */
export function eventHighWaterBytes(): number {
  const v = Number(process.env.REMOTE_CONTROL_EVENT_HIGH_WATER_BYTES)
  return Number.isFinite(v) && v > 0 ? v : 1024 * 1024
}

/**
 * Reconnect delay for an attempt (1-based), doubling with ±20% jitter so a
 * relay coming back up is not hit by every bridge in the same instant.
 */
export function backoffDelay(attempt: number, base = reconnectBaseMs(), max = reconnectMaxMs()): number {
  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1))
  const jitter = exponential * 0.2 * (Math.random() * 2 - 1)
  return Math.max(0, Math.min(max, Math.round(exponential + jitter)))
}

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
