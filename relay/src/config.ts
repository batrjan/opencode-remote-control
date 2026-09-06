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
 * Optional admin key. No longer required for the public session API
 * (registration is public + rate-limited; deletion requires the session's
 * bridge_token). Kept only for backward compatibility with older bridges.
 */
export function relayApiKey(): string {
  return process.env.RELAY_API_KEY ?? ''
}

/**
 * Artificial delay (ms) before answering a *failed* activation attempt —
 * a brute-force brake mandated by the design spec (1–2 s in production).
 * Read lazily from ACTIVATE_FAIL_DELAY_MS; tests set it to 0.
 */
export function activateFailDelayMs(): number {
  return Number(process.env.ACTIVATE_FAIL_DELAY_MS ?? 1000)
}
