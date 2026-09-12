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
  // NOTE: there is deliberately no per-address limit on activation attempts.
  // An address is cheap to change, so it throttles the careless and not the
  // determined, while the people it does reach are colleagues sharing one
  // office NAT. The brake that matters is sessionFailLockThreshold below,
  // which counts per SESSION and therefore cannot be spread across addresses.
  // req.ip still governs REGISTRATION (registrationsPerWindow,
  // maxActiveSessionsPerIp), so `trust proxy` remains security-relevant.
  /**
   * Repeats of one specific wrong code against one session before that exact
   * guess is refused outright, without even reaching the hash compare.
   *
   * Below sessionFailLockThreshold on purpose. The session lock fires after 5
   * consecutive failures of ANY code, so a threshold of 10 here could never be
   * reached inside a single lock window — the mechanism would have been dead
   * code wearing the appearance of a defence. Three is enough: one attempt
   * already proved the guess wrong, so repeating it is either a stuck client
   * or noise, and answering it from a set lookup costs nothing.
   */
  codeFailBlockThreshold: 3,
  /**
   * Per-session brute-force brake, and the one that actually matters.
   *
   * Counted per SESSION and CONSECUTIVELY: any successful activation clears
   * it, so reaching the threshold means nobody got the code right this many
   * times running — which is what guessing looks like. Deliberately not keyed
   * on the client address: an address is cheap to change and a determined
   * attacker spreads the grind across many, so a per-address limit alone is a
   * speed bump, not a defence.
   *
   * Five is generous against the only threat here. The lockout caps an
   * attacker at 5 guesses per 15 minutes — 480 a day against a 6-character
   * code from a 34-symbol alphabet (34^6 ~ 1.5e9), which is roughly 4,400
   * years to an even chance of hitting one. Lowering it from 20 costs nothing
   * in strength and cuts the exposure window fourfold. (The arithmetic is
   * asserted in relay/test/activation-budget.test.ts so the numbers here
   * cannot quietly drift apart from the constants below.)
   *
   * The cost is borne by accidents, not attackers: while locked, activation is
   * refused for EVERYONE, correct code included. That is not an oversight —
   * letting a correct code through during a lockout would let a distributed
   * attacker keep guessing at full speed and simply win on a lucky try, which
   * is exactly what the lockout exists to prevent. Being consecutive is what
   * keeps this tolerable: one person's typo is forgotten the moment anyone
   * gets in.
   */
  sessionFailLockThreshold: 5,
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
  /**
   * Viewer tokens are a SLIDING window: a token that has not been used for
   * this long stops authenticating and is pruned. Without it a viewer kept
   * access for the entire life of the share and the viewer map grew forever.
   * Matched to orphanReapMs so a viewer token never outlives the session it
   * belongs to (both 24 hours).
   */
  viewerIdleTtlMs: 24 * 3_600_000,
  /**
   * Max concurrent viewer tokens one session may hold. Every activation mints
   * a fresh token (a reload, a second device, a re-join after a cookie loss),
   * so the map is unbounded without a cap. At the cap an IDLE token is
   * evicted to make room — see viewerActiveWindowMs for why only an idle one.
   */
  maxViewersPerSession: 32,
  /**
   * How recently a viewer must have been seen to count as present.
   *
   * Eviction at the cap used to take the least-recently-used token whatever it
   * was, which meant anyone holding the access code could mint tokens until
   * every existing viewer had been pushed out — they gained nothing they did
   * not already have, but they could silently drop everyone else. A viewer
   * seen inside this window is now never displaced: the join is refused
   * instead, so a share that is genuinely full says so rather than quietly
   * taking someone's seat. Only seats nobody is sitting in get reclaimed.
   */
  viewerActiveWindowMs: 5 * 60_000,
  /**
   * Successful activations one SESSION may accept per window.
   *
   * Separate from the per-address limit on wrong codes: this one bounds how
   * fast viewer tokens can be minted at all, by anyone, including someone
   * holding a perfectly valid code. Sized well above a real team — the viewer
   * cap is 32, so this is every seat filled twice over inside ten minutes —
   * because the point is to stop a machine churning tokens, not to ration
   * colleagues. It cannot by itself stop a determined code-holder from
   * occupying seats (32 people joining and one attacker minting 32 tokens are
   * indistinguishable by volume); viewerActiveWindowMs is what protects the
   * people already in.
   */
  activationsPerSessionWindow: 64,
  activationSessionWindowMs: 10 * 60_000,
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
