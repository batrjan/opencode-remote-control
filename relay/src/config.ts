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
   * How long a registration may wait for its bridge before it stops holding a
   * slot. A registration no bridge has connected to for longer is removed by
   * the reaper, and by a full relay (see maxSessions) before it refuses anyone.
   *
   * Idle time alone let a registration nobody took up keep its slot for the
   * full orphanReapMs. With five active sessions per address, 400 addresses
   * filled a 2,000-session relay inside an hour with bare POSTs, and every new
   * share after that got 503 "relay full" for a day, renewable at will. A real
   * bridge dials the moment its registration comes back, and deletes the
   * registration when that dial fails (its handshake times out after 15 s), so
   * minutes are plenty. Counted from registration, or from a restart for one
   * restored before its bridge had connected. The reaper leaves a share whose
   * bridge connected once its day, however long it has been gone since: telling
   * a laptop that is asleep from one that will never return is not possible
   * here. A full relay does not wait that day, though (see departedBridgeMs).
   */
  unboundReapMs: 5 * 60_000,
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
 * How much of ONE oversized SSE frame the stuck-viewer cap discounts while it
 * is still waiting in the backlog (see the SSE fan-out in the proxy adapter).
 *
 * The cap exempts a single large frame so a pasted image or big diff reaches a
 * viewer that keeps reading. Left unbounded, that exemption is only as small
 * as one ws frame — and one ws frame is bounded by the bridge socket's
 * maxPayload (bridgeMaxPayloadBytes). A viewer that took one such frame
 * and then read nothing kept the whole thing buffered: only heartbeats were
 * counted against the cap and they never reach it. Bounding the exemption
 * means a frame larger than this trips the ordinary per-write check on the
 * next frame, so a non-reading viewer can hold at most about this much beyond
 * the cap. Generous enough for a phone photo pasted as a data URL (a few MiB,
 * ~1.33x base64) or a large diff, so a reading viewer still gets those whole.
 *
 * maxPayload is therefore the CEILING here, and this is derived from it rather
 * than set beside it. A fixed 32 MiB against a 16 MiB frame cap read as "an
 * event up to 32 MiB is handled gently", and no such event exists: ws answers a
 * frame past maxPayload with a protocol error, the relay terminates that socket
 * (see the 'error' handler in ws/bridge.ts) and the owner's bridge drops
 * mid-share — the fan-out never gets to discount anything. Smaller than one
 * frame is still meaningful (that is the stuck-viewer bound above), larger
 * never is, so an env value above the frame cap is clamped to it and raising
 * the frame cap for an install that pastes bigger media raises this with it.
 */
export function sseMaxExemptBytes(): number {
  const oneFrame = bridgeMaxPayloadBytes()
  return Math.min(envInt('RELAY_SSE_MAX_EXEMPT_BYTES', oneFrame), oneFrame)
}

/**
 * Most all viewer streams together may hold over the stuck-viewer cap, across
 * every session (see the SSE fan-out in the proxy adapter).
 *
 * The cap and the exemption bound each stream, and only from its next write
 * or heartbeat: one large event is written into every open stream at once, so
 * without a shared bound 64 non-reading streams and one 100 MiB ws frame put
 * 6.4 GB in memory before either could act. Checked before each write, so a
 * frame that would take the total past it is not written: its stream is
 * dropped and the viewer reconnects. Room for a few maximal exempt frames at
 * once, or a pasted photo reaching a couple of dozen streams; while it is used
 * up, a viewer is dropped for a large event instead of the relay running out
 * of memory. Counted in the same units as the cap.
 */
export function sseMaxParkedBytes(): number {
  return envInt('RELAY_SSE_MAX_PARKED_BYTES', 128 * 1024 * 1024)
}

/**
 * The largest single frame the relay accepts from a bridge — set as the bridge
 * WebSocketServer's maxPayload (relay/src/ws/bridge.ts) and mirrored as the
 * gunzip output ceiling (a compressed body is never inflated past what an
 * uncompressed frame could carry).
 *
 * Registration is public, so a "bridge" can be anyone. Without a maxPayload, ws
 * accepts frames up to its 100 MiB default, and a proxy_response body that large
 * is buffered whole in the relay heap on its way to a viewer — the DoS a slow or
 * non-reading GET socket used to exhaust the relay with (see the security run's
 * verify-1/dos.mjs). Capping the frame bounds what one response, or one gunzip,
 * can cost.
 *
 * Sized above the largest LEGITIMATE frame — a live event carrying a pasted
 * image as a data URL, which the tests exercise at 12 MiB — and below the
 * tens-of-MiB bodies the DoS relied on. Env-tunable for an install that pastes
 * larger media; the aggregate proxy ceiling (proxyMaxBufferedBytes) is what
 * bounds memory when many honest multi-MiB responses are in flight at once.
 *
 * This is the CEILING every other one-frame limit is measured against, because
 * it is the only one enforced by dropping the bridge: the SSE one-frame
 * exemption (sseMaxExemptBytes) is clamped to it, the gunzip output limit is
 * min'd with it, and the aggregate proxy ceiling is floored at eight of it (see
 * proxyMaxBufferedBytes for why eight and not one). A number above it promises
 * something no frame can deliver; anything that must carry a whole frame has to
 * be at least it. Raise it and those follow — they are derived here, not
 * repeated.
 */
export function bridgeMaxPayloadBytes(): number {
  return envInt('RELAY_BRIDGE_MAX_PAYLOAD_BYTES', 16 * 1024 * 1024)
}

/**
 * Process-wide ceiling on response-body bytes the proxy path holds buffered for
 * viewers that read slowly or not at all, summed across every in-flight proxy
 * response (see the proxy adapter's sendBounded).
 *
 * Unlike the SSE fan-out — which bounds its own parked bytes (sseMaxParkedBytes)
 * — the proxy path used to buffer a full response body with no cumulative bound:
 * a public registrant whose own bridge returned multi-MiB bodies to non-reading
 * GET sockets grew the heap by the full body per socket until the relay OOM'd,
 * taking down every share. maxPayload bounds ONE response; this bounds the SUM
 * in flight. A body that would push the total over the ceiling is answered 503
 * rather than buffered, so memory stays at about this plus one maxPayload
 * however many slow readers pile up. Generous enough for several honest
 * multi-MiB transcripts at once; env-tunable.
 *
 * Never below EIGHT maxPayloads, whatever the env says. One, because a body the
 * bridge socket accepted must be admissible at least on its own: below that,
 * every response of a size the frame cap allows would be answered 503 `relay
 * busy` with the relay holding nothing at all — the sum cannot be a stricter
 * limit on ONE response than the frame cap already is. Eight, because the proxy
 * adapter hands each registration an eighth of this ceiling and never less than
 * one frame (proxySessionShareBytes), so that a share flooding the proxy path
 * can only deny itself; at a ceiling under eight frames that slice rounds up to
 * the whole ceiling and the split stops separating the shares at all.
 */
export function proxyMaxBufferedBytes(): number {
  return Math.max(envInt('RELAY_PROXY_MAX_BUFFERED_BYTES', 128 * 1024 * 1024), 8 * bridgeMaxPayloadBytes())
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
 *
 * Only a share with a bridge keeps its slot for long: a full relay first drops
 * the registrations no bridge connected to in time (config.unboundReapMs), and
 * then gives one new registration the slot of the share whose bridge has been
 * gone longest (departedBridgeMs). Filling it takes a bridge per session that
 * keeps answering, not a bare POST, nor a handshake every few minutes (only a
 * socket that stays a ping interval renews a slot, see Store.touchSession).
 */
export function maxSessions(): number {
  return envInt('RELAY_MAX_SESSIONS', 2000)
}

/**
 * How long a share's bridge must have shown no sign of life before a full
 * relay may give that share's slot to a new registration (see
 * Store.checkRegistrationLimit).
 *
 * A connected bridge touches its session on every pong and every byte it
 * sends, and one that stays silent for more than wsPongGraceRounds() ping
 * rounds is terminated. So a share silent for longer than those rounds and one
 * more has no bridge socket, whatever the ping interval is set to. Never less
 * than config.unboundReapMs, the time a new registration gets to dial in: a
 * bridge that lost its link re-dials within seconds, and one on a laptop that
 * slept for a minute should find its share still there.
 *
 * Without this, one WebSocket handshake per registration took a session out of
 * the unbound rule for the reaper's whole day: 400 addresses registered 2,000
 * sessions, connected and disconnected once each, and every new share got 503
 * "relay full" for a day, renewable with one more handshake per session. The
 * cost is borne only on a full relay, by the share gone quiet longest: its
 * bridge, if it ever wakes, is refused and must share again (the id stays
 * reserved for its owner_key).
 */
export function departedBridgeMs(): number {
  return Math.max(config.unboundReapMs, (wsPongGraceRounds() + 2) * wsPingIntervalMs())
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

/** Parse a boolean env var: 1/true/yes/on are true, everything else `def`. */
function envBool(name: string, def: boolean): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase()
  if (raw === '') return def
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

/**
 * Whether the relay's OWN HTML shells (the UI shell, the join page, the ended
 * page) carry a Content-Security-Policy — see sendShell in server.ts. Only the
 * shells: the proxied opencode API and the SPA bundle are not touched.
 *
 * Defaults OFF. The CSP hashes every inline <script> the shell carries and
 * allowlists exactly what the upstream opencode SPA needs (its 'self' bundle,
 * 'wasm-unsafe-eval', inline styles, blob:/data: for workers/images/fonts, and
 * same-origin fetch/SSE) and no more. That "no more" can only be confirmed in a
 * real browser against the live SPA, so the flag keeps a rolling deploy safe:
 * production stays as it is until the coordinator has browser-verified the
 * policy, then turns it on with RELAY_SHELL_CSP=1.
 */
export function shellCspEnabled(): boolean {
  return envBool('RELAY_SHELL_CSP', false)
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
