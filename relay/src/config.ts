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
   * sessionFails, sessionActivations, registrations, claims). When a map is
   * full the oldest entry is evicted (FIFO) so memory stays bounded under
   * brute-force or registration floods.
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
   * How long an ended share's session id stays reserved for the install that
   * registered it with an owner_key (see Store.createSession). The id is in
   * the share link, and the owner registers the same id again whenever they
   * share that conversation; without the reservation anyone holding an old
   * link could register it first and hold it with a connected socket. Long
   * enough to cover a conversation picked up again weeks later; bounded so an
   * install that lost its key (a new machine, a wiped home) gets its old ids
   * back eventually. 30 days.
   */
  ownerClaimTtlMs: 30 * 24 * 3_600_000,
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
   * Separate from the per-session lock on wrong codes: this one bounds how
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
 * How long a GET whose bridge dropped mid-request waits for that bridge to come
 * back before failing. A bridge re-dials within about a second of losing its
 * link, so a network blip on the owner's side becomes a short delay for the
 * viewer instead of a 502. Only GETs: repeating a prompt is not harmless. A
 * prompt caught by a drop waits as long, but only to ask opencode whether it
 * landed (see proxyPrompt in the proxy adapter).
 */
export function bridgeReconnectWaitMs(): number {
  return envInt('RELAY_BRIDGE_RECONNECT_WAIT_MS', 5_000)
}

/**
 * How long the relay waits for opencode's answer to a viewer's prompt
 * (POST /session/:id/prompt_async). opencode answers a prompt in tens of
 * milliseconds — it starts the turn and returns — so the rest of any wait is
 * the owner's uplink, where the answer queues behind whatever the bridge is
 * already sending (a file preview, a transcript). Neither the web UI's fetch
 * nor nginx gives up on it, so the ordinary 30 s proxy timeout was the only
 * clock, and it ran out on answers that were on their way.
 */
export function promptTimeoutMs(): number {
  return envInt('RELAY_PROMPT_TIMEOUT_MS', 120_000)
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
 * Most one viewer's SSE stream may hold queued in the relay, unread, before
 * that viewer is dropped (it reconnects on its own).
 *
 * Behind nginx with proxy_buffering off, a viewer that stops reading pushes
 * back straight onto the relay, and every event it has not taken waits in
 * this process. Without a cap one stuck phone grew by the full rate of the
 * owner's output, and 64 streams on a single viewer token multiplied that
 * into an out-of-memory crash of the relay and every share on it.
 *
 * It is not a limit on the size of one event: one large event still waiting
 * for a viewer is not counted against it (see the SSE fan-out in the proxy
 * adapter), so a pasted image or a big diff reaches a viewer that keeps
 * reading even when it is larger than the cap. But a session's 64 streams can
 * all sit just under it at once, so it cannot be generous. At 4 MiB those 64
 * streams alone filled a 256 MB heap and the relay still died; 2 MiB held
 * under the same sustained attack. Counted the way Node counts a write backlog
 * (string length), so it is approximate in bytes.
 */
export function sseMaxBufferBytes(): number {
  return envInt('RELAY_SSE_MAX_BUFFER_BYTES', 2 * 1024 * 1024)
}

/**
 * Most sessions the relay holds at once, whoever registered them.
 *
 * Registration is public and the other caps are per client address, so on
 * their own they bounded nothing in total: a pool of addresses (a botnet, a
 * residential proxy service) could lodge sessions without end, five each. Every
 * session is up to ~5 KB of registration fields plus its viewers, and all of
 * it sits in memory and is rewritten to the state file on every change, so the
 * total has to stop somewhere. Far above what the relay's real shares need; a
 * refusal is logged, so a relay that is merely busy can be given more.
 */
export function maxSessions(): number {
  return envInt('RELAY_MAX_SESSIONS', 2000)
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
 * The registration caps (registrationsPerWindow, maxActiveSessionsPerIp) key
 * on req.ip, so this must match the deployment exactly. Too narrow and every
 * client collapses into the proxy's own address: the whole service shares a
 * single IP's registration budget and session cap. Too wide and a client
 * spoofs its way past the caps. Activation does not key on it (see the NOTE
 * above codeFailBlockThreshold); there req.ip only labels the log line.
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
 * Reconnect delay advertised in the SSE `retry:` field. A plain EventSource
 * waits this long after the stream drops. The web UI's own reader does NOT
 * ignore it: it takes it as the base of its backoff, doubling it for every
 * failed attempt up to 30 s, so this sets how soon a viewer retries after an
 * error. It must stay positive (envInt refuses 0): a zero base would have the
 * UI retry in a tight loop.
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
