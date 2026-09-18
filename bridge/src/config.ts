/**
 * Central bridge configuration. Secrets come from the environment and are
 * read lazily (at call time) so tests and CLI flag overrides can set them
 * after module load.
 */
export const config = {
  /** Path probed on candidate OpenCode ports during auto-detection. */
  healthPath: '/global/health',
  /**
   * Per-port health probe timeout; keeps detection fast with stale listeners.
   * Detection only — the running share's watchdog has its own, longer deadline
   * (watchdogProbeTimeoutMs).
   */
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
 * Deadline for asking a candidate server whether it holds the session a share
 * is about to serve (see holdsSession).
 *
 * Deliberately longer than the health probe's 1.5 s, which is tuned for
 * skipping stale listeners: this question is put to a server that has just
 * answered as alive, and a wrong answer is not "skip a dead port" but "run the
 * share on a server of our own instead of the owner's". opencode reads the
 * session from disk, so even one busy with a prompt answers in well under a
 * second; five leaves room for a machine under load.
 */
export function sessionProbeTimeoutMs(): number {
  const v = Number(process.env.REMOTE_CONTROL_SESSION_PROBE_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 5_000
}

/**
 * The opencode port the owner named in the environment, or undefined.
 *
 * The escape hatch for detection: a server named here is used as `--port`
 * names one — no scan, no session test, because the owner has already said
 * which server is theirs. It exists because the paths that need it most have
 * no flags to pass: the TUI plugin runs `start` itself, so before this there
 * was no way at all to point a share at a specific server from inside OpenCode.
 *
 * A value that is not a port is warned about and ignored rather than fatal:
 * falling back to detection shares the session, while refusing to start leaves
 * the owner with nothing over a stray setting.
 */
export function namedOpencodePort(env = process.env): number | undefined {
  const raw = env.OPENCODE_REMOTE_CONTROL_PORT
  if (raw === undefined || raw.trim() === '') return undefined
  const port = Number(raw)
  if (Number.isInteger(port) && port > 0 && port <= 65535) return port
  console.warn(
    `bridge: ignoring OPENCODE_REMOTE_CONTROL_PORT=${JSON.stringify(raw)} — not a port number; detecting the opencode server instead`,
  )
  return undefined
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
 * Deadline for one watchdog health probe of the local opencode server. It used
 * to be detection's 1.5 s, which is tuned for skipping stale listeners during a
 * port scan, not for judging a server that is in use: a server busy with the
 * very prompt a viewer just sent, or a bridge whose own event loop stalled for
 * a moment, missed it and the share was ended. Proxied requests to the same
 * server get 30 s; a live server answering its health route needs far less.
 */
export function watchdogProbeTimeoutMs(): number {
  const v = Number(process.env.REMOTE_CONTROL_WATCHDOG_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 5_000
}

/**
 * Consecutive failed health probes after which the watchdog ends the share.
 * One was enough, so a single slow answer revoked the code and every viewer
 * token and killed the server the bridge had spawned. A server that is really
 * gone keeps failing, so it is still caught, a few intervals later.
 */
export function watchdogStrikes(): number {
  const v = Number(process.env.REMOTE_CONTROL_WATCHDOG_STRIKES)
  return Number.isInteger(v) && v > 0 ? v : 3
}

/**
 * Deadline for the relay WebSocket's opening handshake: DNS, TCP connect, TLS
 * and the HTTP upgrade. ws applies it as an idle timeout on the socket, so it
 * only fires once nothing has crossed it for this long. The whole handshake is
 * a few kilobytes, which even a 0.7 Mbit/s uplink moves in well under a
 * second; it stays well below the plugin's two-minute wait for a starting
 * bridge, so a stalled first dial fails and cleans up before the plugin gives
 * up on it.
 */
export function wsHandshakeTimeoutMs(): number {
  const v = Number(process.env.REMOTE_CONTROL_WS_HANDSHAKE_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 15_000
}

/**
 * Deadline for the relay DELETE that ends a session. The request used to carry
 * none: against a relay that accepts the connection and never answers (a
 * wedged upstream, a black-holed network) `stop` was still waiting after 25 s,
 * and the plugin only gave up when its 15 s wait for the CLI killed it, with
 * nothing torn down. The request is a few hundred bytes, which even a
 * 0.7 Mbit/s uplink moves in well under a second; the deadline leaves `stop`
 * room inside that 15 s to take the share down locally and say what happened.
 * `status` bounds its session probe by the same deadline, for the same reason.
 */
export function relayDeleteTimeoutMs(): number {
  const v = Number(process.env.REMOTE_CONTROL_RELAY_DELETE_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 5_000
}

/**
 * Deadline for the relay registration (POST /api/sessions) that starts a share.
 * The request carried none, so a relay that accepted the connection and never
 * answered (a wedged upstream, a black-holed path) held `start` open for as
 * long as the socket lived. The plugin gives a starting bridge two minutes and
 * cancels it after that, so a registration nobody answers must fail well inside
 * that window, with a reason the owner is shown instead of a bare cancel. The
 * request and its answer are a few hundred bytes each, which even a
 * 0.7 Mbit/s uplink moves in well under a second.
 */
export function relayRegisterTimeoutMs(): number {
  const v = Number(process.env.REMOTE_CONTROL_RELAY_REGISTER_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 15_000
}

/**
 * Proxy requests from the relay this bridge runs at once. Everything past it
 * is answered 503 straight away rather than queued.
 *
 * The relay decided this number before: every `proxy` frame was handled the
 * moment it arrived, so one relay — compromised, or merely wedged and
 * repeating its queue — could put thousands of requests on the owner's
 * opencode at once, each with its own socket, timer and buffered answer. The
 * ceiling is generous next to what a share really does (a viewer's UI
 * bootstrap is a few dozen requests, and the relay's own per-share slice
 * bounds it further), so it only ever fires on traffic no viewer produced.
 */
export function maxInflightProxyRequests(): number {
  const v = Number(process.env.REMOTE_CONTROL_MAX_INFLIGHT_PROXY)
  return Number.isInteger(v) && v > 0 ? v : 64
}

/**
 * The largest frame the bridge accepts from the relay (ws maxPayload).
 *
 * Without one ws allows its own 100 MiB default and buffers the whole frame in
 * this process before anything can judge it. What the relay legitimately sends
 * is a proxy frame carrying a viewer's POST body, and the relay caps those at
 * 25 MB (PROXY_BODY_LIMIT), so this leaves headroom over the largest real one
 * and refuses anything an order of magnitude past it: ws answers such a frame
 * with a protocol error and the link is re-dialled, which costs one share's
 * requests in flight instead of the owner's memory.
 */
export function relayMaxPayloadBytes(): number {
  const v = Number(process.env.REMOTE_CONTROL_RELAY_MAX_PAYLOAD_BYTES)
  return Number.isFinite(v) && v > 0 ? v : 32 * 1024 * 1024
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
 *
 * `password` overrides the environment: a server the bridge spawned has a
 * password of the bridge's own making (see ensureOpenCodeServer), which is
 * deliberately nowhere in the environment.
 */
export function opencodeAuthHeader(password?: string): string {
  return basicAuthHeader(
    process.env.OPENCODE_SERVER_USERNAME ?? 'opencode',
    password ?? process.env.OPENCODE_SERVER_PASSWORD ?? '',
  )
}
