/**
 * Central relay configuration. All security-critical values live here.
 */
const EXCLUDED_FROM_CODE_ALPHABET = ['O', 'I'] as const

export const config = {
  /** Port the relay listens on (used by the entrypoint added in a later task). */
  port: Number(process.env.PORT ?? 8080),
  /** Length of the human-readable access code. */
  codeLength: 6,
  /**
   * Code alphabet: [A-Z0-9] minus 'O', 'I' (34 chars total).
   * Built by explicit exclusion so the policy is readable, not hardcoded.
   */
  codeAlphabet: Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    .filter((c) => !(EXCLUDED_FROM_CODE_ALPHABET as readonly string[]).includes(c))
    .join(''),
  /** Per-IP activation attempt limits (sliding window evaluated lazily). */
  ipLimitPerMinute: 5,
  ipLimitPerHour: 50,
  ipWindowMs: { minute: 60_000, hour: 3_600_000 },
  /** Global failed-attempt threshold per code before the code is blocked. */
  codeFailBlockThreshold: 10,
  /**
   * Per-session brute-force brake: after this many failed activations against
   * one session (any code) within sessionFailLockMs, activation for that
   * session is temporarily locked. This is the effective defense against
   * grinding a known session's code across many IPs.
   */
  sessionFailLockThreshold: 20,
  sessionFailLockMs: 15 * 60_000, // 15 minutes
  /** Token entropy (bytes) for bridge/viewer tokens. */
  tokenBytes: 32,
  /** Salt entropy (bytes) for salted SHA-256 secret hashing. */
  saltBytes: 16,
  /** How long the proxy adapter waits for a bridge response over WS. */
  proxyTimeoutMs: 30_000,
  /**
   * Max entries in the in-memory tracking maps (codeFails, blockedCodes,
   * ipAttempts). When a map is full the oldest entry is evicted (FIFO) so
   * memory stays bounded under brute-force traffic.
   */
  maxTrackingEntries: 100_000,
  /**
   * Public session registration caps (no shared key — the skill works out of
   * the box): registrations per IP per window, and max active sessions one IP
   * may hold. Deleting a session requires its bridge_token instead, so the
   * public path can never kill someone else's share.
   */
  registrationsPerWindow: 12,
  registrationWindowMs: 3_600_000, // 1 hour
  maxActiveSessionsPerIp: 5,
  /**
   * Orphan reaper: sessions idle (no bridge traffic) longer than this are
   * deleted. Cleans up abandoned shares (bridge killed -9, or a registration
   * never followed through). 24 hours.
   */
  orphanReapMs: 24 * 3_600_000,
  orphanSweepIntervalMs: 15 * 60_000, // sweep every 15 minutes
} as const

/**
 * Keep-alive tuning. On a flaky network a TCP connection can go half-open:
 * both ends still believe the socket is up while nothing gets through. These
 * intervals make every hop prove it is alive, so the share recovers instead
 * of silently doing nothing.
 *
 * Read lazily from the environment so tests can shrink them.
 */
export function wsPingIntervalMs(): number {
  return envInt('RELAY_WS_PING_INTERVAL_MS', 25_000)
}

/**
 * Missed-pong grace: a bridge socket that has not answered within this many
 * ping rounds is terminated, freeing the session for the bridge's reconnect
 * and failing pending proxy requests instead of hanging viewers.
 */
export function wsPongGraceRounds(): number {
  return envInt('RELAY_WS_PONG_GRACE_ROUNDS', 2)
}

/**
 * How often the viewer's SSE stream gets a heartbeat event. Also keeps
 * intermediate proxies (nginx, corporate middleboxes) from closing an idle
 * stream. Must be a real `server.heartbeat` event: the web UI's reader parses
 * comment lines as events and dies on them.
 */
export function sseHeartbeatMs(): number {
  return envInt('RELAY_SSE_HEARTBEAT_MS', 15_000)
}

/**
 * Optional admin key. No longer required for the public session API
 * (registration is public + rate-limited; deletion requires the session's
 * bridge_token). Kept only for backward compatibility with older bridges.
 */
/** Parse a positive integer env var, falling back to `def` on empty/NaN/<=0. */
function envInt(name: string, def: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def
}

export function relayApiKey(): string {
  return process.env.RELAY_API_KEY ?? ''
}

/**
 * Express `trust proxy`: which peers' X-Forwarded-For to believe.
 *
 * Every per-IP limit (activation brute-force brake, registration caps) keys
 * on req.ip, so this must match the deployment exactly. Too narrow and every
 * client collapses into the proxy's own address: one attacker's five wrong
 * codes lock activation for EVERYONE, and the whole service shares a single
 * IP's session cap. Too wide and a client spoofs its way past the limits.
 *
 * The default `loopback` fits nginx on the same host in front of a bare
 * `npm start`. Inside Docker the proxy reaches the container from the bridge
 * gateway (172.x), which is NOT loopback, so compose sets
 * `loopback, uniquelocal` (RFC 1918 + loopback): the port is published on
 * 127.0.0.1 only, so that peer can only be the host's own nginx. `false`
 * trusts no header at all (a relay exposed directly, with no proxy).
 */
export function trustProxy(): boolean | number | string {
  const raw = (process.env.RELAY_TRUST_PROXY ?? '').trim()
  if (raw === '') return 'loopback'
  if (raw === 'false' || raw === '0') return false
  if (raw === 'true') return true
  if (/^\d+$/.test(raw)) return Number(raw)
  return raw
}

/**
 * Reconnect delay advertised to standards-compliant SSE clients (the `retry:`
 * field). The web UI runs its own reader with its own policy and ignores it;
 * a plain EventSource uses it after the stream drops.
 */
export function sseRetryMs(): number {
  return envInt('RELAY_SSE_RETRY_MS', 3000)
}

/**
 * Where the session set is persisted so a relay restart does not drop live
 * shares. Empty (the default) keeps the old in-memory-only behaviour, which
 * is what tests and local runs want; production sets it to a path on a volume.
 */
export function stateFile(): string {
  return process.env.RELAY_STATE_FILE ?? ''
}

/**
 * Artificial delay (ms) before answering a *failed* activation attempt —
 * a brute-force brake mandated by the design spec (1–2 s in production).
 * Read lazily from ACTIVATE_FAIL_DELAY_MS; tests set it to 0.
 */
export function activateFailDelayMs(): number {
  return Number(process.env.ACTIVATE_FAIL_DELAY_MS ?? 1000)
}
