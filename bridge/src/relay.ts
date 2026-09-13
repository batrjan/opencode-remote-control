import type { Socket } from 'node:net'
import { gzip } from 'node:zlib'
import WebSocket from 'ws'
import type { OpencodeClient } from './opencode.js'
import {
  backoffDelay,
  eventHighWaterBytes,
  eventRetryMs,
  relayDeleteTimeoutMs,
  relayRegisterTimeoutMs,
  wsHandshakeTimeoutMs,
  wsPingIntervalMs,
} from './config.js'

/**
 * Client for the public relay's bridge-facing session API.
 *
 * Auth is per-session, not shared: registration (POST) is public and
 * rate-limited per IP, while DELETE/GET carry the session's OWN `bridge_token`
 * in `x-bridge-token`, so only the bridge that registered a session can end it
 * or read its owner-only fields. `apiKey` is a legacy `x-api-key` header kept
 * for relays that still gate registration behind a shared secret; the public
 * relay does not require it.
 */
export interface RelaySession {
  session_id: string
  access_code: string
  bridge_token: string
  viewer_url: string
}

/** Non-secret session status returned by GET /api/sessions/:id. */
export interface SessionStatus {
  session_id: string
  /** Owner-only (needs the bridge_token); absent from the public presence view. */
  directory?: string
  /** Owner-only (needs the bridge_token); absent from the public presence view. */
  title?: string
  status: 'active' | 'closed'
  created_at: number
  last_seen: number
  viewer_count: number
  bridge_connected: boolean
}

export class RelayClient {
  constructor(
    public url: string,
    public apiKey?: string,
  ) {}

  private headers() {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    // Optional legacy key — the public relay does not require it.
    if (this.apiKey) h['x-api-key'] = this.apiKey
    return h
  }

  /**
   * Register a session; secrets (access_code, bridge_token) return once.
   *
   * Bounded by `timeoutMs`, answer body included: `start` runs it before
   * anything is printed, and a relay that never answers must fail the start
   * with a reason rather than hold it until the plugin cancels it.
   */
  async createSession(
    sessionId: string,
    directory: string,
    title: string,
    timeoutMs = relayRegisterTimeoutMs(),
  ): Promise<RelaySession> {
    try {
      const res = await fetch(`${this.url}/api/sessions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ session_id: sessionId, directory, title }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`relay createSession failed: ${res.status}`)
      return (await res.json()) as RelaySession
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`relay createSession failed: no answer within ${timeoutMs / 1000} s`)
      }
      throw err
    }
  }

  /**
   * End a session on the relay. Requires the session's own bridge_token.
   *
   * Bounded by `timeoutMs` (rejects with a TimeoutError): every caller runs it
   * while shutting a share down, and a relay that never answers must not be
   * able to hold that shutdown open.
   */
  async deleteSession(sessionId: string, bridgeToken: string, timeoutMs = relayDeleteTimeoutMs()): Promise<number> {
    const res = await fetch(`${this.url}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { ...this.headers(), 'x-bridge-token': bridgeToken },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.status
  }

  /** Session status probe for `bridge status`. Returns parsed body + HTTP status. */
  async getSession(sessionId: string, bridgeToken?: string): Promise<{ status: number; body?: SessionStatus }> {
    const res = await fetch(`${this.url}/api/sessions/${encodeURIComponent(sessionId)}`, {
      // The bridge_token unlocks the owner-only fields (directory, title) that
      // the public presence view withholds.
      headers: { ...this.headers(), ...(bridgeToken ? { 'x-bridge-token': bridgeToken } : {}) },
    })
    if (res.status !== 200) return { status: res.status }
    return { status: 200, body: (await res.json()) as SessionStatus }
  }
}

/* -------------------------- bridge-side path allowlist -------------------------- */

/** The only verbs the relay proxy protocol ever legitimately carries. */
type ProxyMethod = 'GET' | 'POST'

/**
 * What the relay may ask THIS machine to do.
 *
 * A `proxy` frame hands us a method and a path that land verbatim on the local
 * opencode server — a server that runs shell commands, reads any file and
 * rewrites the project. The only allowlist used to live in the relay
 * (relay/src/proxy/adapter.ts), i.e. on a host the bridge merely dials: a
 * compromised, swapped or DNS-hijacked relay could drive any verb at any path
 * against every connected user's machine, which is remote code execution on
 * their laptop. The check has to exist on the side that pays for it being
 * wrong, so the same surface is re-derived here.
 *
 * This table is a SUPERSET of what the relay actually sends: every entry of the
 * relay's ALLOWED_ROUTES, plus the paths its own handlers build rather than
 * template (`/project`, `/project/current`, `/permission`, `/question`,
 * `/session/status`, and `/session/<ses_…>` from the subagent ancestry walk).
 * Each entry also covers its `/api/…` twin — the opencode web UI speaks both
 * dialects against the same server and the relay mounts both.
 *
 * ':id' stands for a session id; ':messageID' / ':permissionID' / ':requestID'
 * stand for one opaque path segment (the relay percent-encodes them).
 */
const RELAY_PROXY_ROUTES: ReadonlyArray<readonly [ProxyMethod, string]> = [
  // Session detail + messages (relay ALLOWED_ROUTES; ':id' is the viewer's
  // bound session, or one of its subagents on the relay's SUBAGENT_ROUTES —
  // the detail, the transcript reads and the permission answer).
  ['GET', '/session/:id'],
  ['GET', '/session/:id/message'],
  ['GET', '/session/:id/message/:messageID'],
  ['POST', '/session/:id/message'],
  ['POST', '/session/:id/prompt_async'],
  ['POST', '/session/:id/abort'],
  ['POST', '/session/:id/command'],
  ['POST', '/session/:id/shell'],
  ['POST', '/session/:id/summarize'],
  ['POST', '/session/:id/revert'],
  ['POST', '/session/:id/unrevert'],
  ['POST', '/session/:id/fork'],
  ['POST', '/session/:id/permissions/:permissionID'],
  ['GET', '/session/:id/todo'],
  ['GET', '/session/:id/children'],
  ['GET', '/session/:id/diff'],
  // Read-only global metadata the UI needs to boot.
  ['GET', '/agent'],
  ['GET', '/command'],
  ['GET', '/config'],
  ['GET', '/config/providers'],
  ['GET', '/provider'],
  ['GET', '/provider/auth'],
  ['GET', '/project'],
  ['GET', '/project/current'],
  ['GET', '/path'],
  ['GET', '/vcs'],
  ['GET', '/mcp'],
  ['GET', '/lsp'],
  ['GET', '/formatter'],
  ['GET', '/experimental/tool'],
  ['GET', '/experimental/tool/ids'],
  // Read-only project browsing (the UI's file tree and previews).
  ['GET', '/file'],
  ['GET', '/file/content'],
  ['GET', '/file/status'],
  ['GET', '/find'],
  ['GET', '/find/file'],
  ['GET', '/find/symbol'],
  // Global v2 surface probed at boot. NOTE: '/global/event' and '/event' are
  // deliberately absent — the SSE stream is never proxied. The bridge opens it
  // itself (startEventForwarding) and the relay fans it out locally from that
  // subscription, so a `proxy` frame asking for it is by definition not the
  // relay doing its job.
  ['GET', '/global/health'],
  ['GET', '/global/config'],
  // Question API: the pending list (the relay filters it to the viewer's
  // session) and the question dock's answer / dismiss. opencode has no
  // POST /question. Reply and reject are additionally ownership-checked in
  // guardRequest: upstream acts on any request id, whatever its session, so
  // only the bound session's and its subagents' questions pass.
  ['GET', '/question'],
  ['POST', '/question/:requestID/reply'],
  ['POST', '/question/:requestID/reject'],
  // Resource / reference APIs the UI bootstrap resolves.
  ['GET', '/experimental/resource'],
  ['GET', '/experimental/capabilities'],
  ['GET', '/experimental/workspace'],
  ['GET', '/api/reference'],
  ['GET', '/api/agent'],
  ['GET', '/api/command'],
  ['GET', '/api/skill'],
  ['GET', '/skill'],
  ['GET', '/pty'],
  ['GET', '/pty/shells'],
  // UI telemetry.
  ['POST', '/log'],
  // Built by the relay's own handlers, not by a route template: the filtered
  // permission list and the per-session status map.
  ['GET', '/permission'],
  ['GET', '/session/status'],
]

/**
 * Both dialects of every route, indexed by verb. The relay serves `/session/…`
 * and `/api/session/…` from the same handlers, and forwards a few routes
 * (`/api/reference`, `/api/skill`, …) under the prefix verbatim — so each
 * template is allowed with and without it.
 */
const PROXY_TEMPLATES: ReadonlyMap<ProxyMethod, readonly string[]> = (() => {
  const byMethod = new Map<ProxyMethod, string[]>([
    ['GET', []],
    ['POST', []],
  ])
  for (const [method, template] of RELAY_PROXY_ROUTES) {
    const list = byMethod.get(method)!
    list.push(template)
    list.push(template.startsWith('/api/') ? template.slice(4) : `/api${template}`)
  }
  return byMethod
})()

/** A real opencode session id — the shape the relay pins every ':id' to. */
const SESSION_ID_RE = /^ses_[A-Za-z0-9_-]+$/

/**
 * Max parent hops the ownership guards walk from a subagent to the bound
 * session. Subagent nesting is shallow; this only bounds a pathological chain
 * (the relay's own ancestry walk uses the same depth).
 */
const MAX_SUBAGENT_DEPTH = 8

let warnedAllowAny = false

/**
 * Forward-compatibility escape hatch. A route added to a newer relay would
 * otherwise be refused by every bridge that has not been updated, bricking the
 * feature with no way out — so allow an operator to opt back into the old
 * "trust the relay" behaviour, loudly and deliberately.
 */
function allowAnyPath(): boolean {
  if (process.env.REMOTE_CONTROL_ALLOW_ANY_PATH !== '1') return false
  if (!warnedAllowAny) {
    warnedAllowAny = true
    console.warn(
      'WARNING: REMOTE_CONTROL_ALLOW_ANY_PATH=1 — this bridge will forward ANY method/path the relay sends to your local opencode server. Unset it unless you are debugging a new relay route.',
    )
  }
  return true
}

/**
 * Whether one path segment may stand in for an id.
 *
 * A segment must stay ONE segment: fetch() re-normalises a percent-encoded dot
 * segment ('%2e%2e') and an encoded slash can reopen the path structure the
 * template just fixed, so judge the decoded value. A NUL truncates the URL for
 * anything downstream that speaks C strings. Malformed percent escapes throw
 * on decode and are refused rather than guessed at.
 */
function isSafeIdSegment(raw: string): boolean {
  if (raw.length === 0 || raw.includes('\0')) return false
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return false
  }
  if (/[/\\\0]/.test(decoded)) return false
  return decoded !== '.' && decoded !== '..'
}

/**
 * A session id segment: the canonical `ses_…` shape, or this bridge's own
 * bound session — the relay force-binds ':id' to the session it registered,
 * and that id is whatever the local opencode server called it.
 */
function isSessionIdSegment(raw: string, boundSessionId?: string | null): boolean {
  if (SESSION_ID_RE.test(raw)) return true
  return Boolean(boundSessionId) && raw === boundSessionId
}

function matchesTemplate(template: string, pathname: string, boundSessionId?: string | null): boolean {
  const want = template.split('/')
  const got = pathname.split('/')
  if (want.length !== got.length) return false
  for (let i = 0; i < want.length; i++) {
    const segment = want[i]!
    const value = got[i]!
    if (segment.startsWith(':')) {
      if (!isSafeIdSegment(value)) return false
      if (segment === ':id' && !isSessionIdSegment(value, boundSessionId)) return false
    } else if (segment !== value) {
      return false
    }
  }
  return true
}

/**
 * Whether a relay-supplied method+path may be forwarded to local opencode.
 * Exported so the allowlist can be tested directly, without a socket.
 *
 * `boundSessionId` is this bridge's own session (see isSessionIdSegment).
 */
export function isProxyRequestAllowed(
  method: string,
  path: string,
  boundSessionId?: string | null,
): boolean {
  if (allowAnyPath()) return true
  const verb = method.toUpperCase()
  if (verb !== 'GET' && verb !== 'POST') return false
  const templates = PROXY_TEMPLATES.get(verb)
  if (!templates) return false
  // The relay appends its own ?directory=… to every forwarded path, so match
  // the pathname alone — a query can only ever reach the endpoint the path
  // already named, and a fragment never leaves fetch() at all.
  const pathname = path.split(/[?#]/)[0] ?? ''
  if (!pathname.startsWith('/')) return false
  return templates.some((template) => matchesTemplate(template, pathname, boundSessionId))
}

/**
 * The query ('' or '?…', fragment dropped) of a relay-forwarded path. It
 * carries the ?directory=… the relay pins, which picks the opencode instance
 * the request acts on — the ownership guards read their pending lists there.
 */
function queryOfPath(path: string): string {
  const queryStart = path.indexOf('?')
  return queryStart === -1 ? '' : path.slice(queryStart).split('#')[0]!
}

/** method+path pairs already reported, so one confused relay cannot spam the
 * log (and cannot grow this set without bound either). */
const warnedRejections = new Set<string>()
const MAX_LOGGED_REJECTIONS = 50

let failedRelayMessages = 0

/** Log a relay frame whose handling threw — a bug, so visible, but budgeted. */
function warnFailedRelayMessage(err: unknown): void {
  if (++failedRelayMessages > MAX_LOGGED_REJECTIONS) return
  console.warn(`bridge: failed to handle a relay message: ${err instanceof Error ? err.message : 'unknown error'}`)
}

/**
 * Log a failed re-dial of the relay. Failures used to be silent, which is how
 * a share that stopped reconnecting left nothing in the log. A relay that is
 * down for hours must not flood it either, so only attempts 1, 2, 4, 8, … of
 * one outage are reported; the count starts over once a dial succeeds.
 */
function warnFailedRedial(attempt: number, err: unknown): void {
  if (attempt < 1 || (attempt & (attempt - 1)) !== 0) return
  console.warn(`bridge: relay re-dial #${attempt} failed: ${err instanceof Error ? err.message : 'unknown error'} — retrying`)
}

/**
 * Report a refused proxy request exactly once. A relay that asks for something
 * outside the contract is either compromised or newer than this bridge — both
 * are worth seeing in the terminal instead of failing silently.
 */
function warnRejectedProxyRequest(method: string, path: string): void {
  const key = `${method} ${path.split(/[?#]/)[0] ?? ''}`
  if (warnedRejections.has(key) || warnedRejections.size >= MAX_LOGGED_REJECTIONS) return
  warnedRejections.add(key)
  console.warn(
    `bridge: refused a relay request outside the allowlist: ${key} (set REMOTE_CONTROL_ALLOW_ANY_PATH=1 only if you trust this relay)`,
  )
}

/**
 * Response bodies at least this large are gzipped when the relay supports it.
 * Below it the saving is a few hundred bytes and not worth a thread-pool trip.
 */
const GZIP_MIN_BYTES = 8 * 1024
/**
 * Protocol limit, mirrored from the relay (relay/src/ws/bridge.ts
 * GZIP_MAX_RATIO): the relay refuses to inflate a body past this multiple of
 * its compressed size, so a body that compresses better goes uncompressed.
 */
const GZIP_MAX_RATIO = 32
/** Nor past what an uncompressed frame could carry. */
const GZIP_MAX_OUTPUT_BYTES = 100 * 1024 * 1024

/** Consecutive keep-alive intervals with no progress at all before a link is dead. */
const KEEPALIVE_STRIKES = 2

/** What one keep-alive tick observed about the link since the previous one. */
export interface LinkSample {
  /** Our ping was answered. */
  pongReceived: boolean
  /** Anything arrived from the relay: a message, its own ping, raw bytes. */
  inboundActivity: boolean
  /** Bytes still waiting in our process at the previous tick (socket writableLength). */
  pendingBefore: number
  /** Bytes whose socket writes had completed, at the previous tick and now. */
  flushedBefore: number
  flushedNow: number
  /**
   * Bytes of the write currently inside libuv that the OS has not yet taken,
   * at the previous tick and now. Undefined where the runtime does not expose it.
   */
  osQueueBefore?: number
  osQueueNow?: number
}

/**
 * Did the link move since the last tick?
 *
 * Inbound traffic is proof by itself. Outbound is proof only under one
 * condition, and getting that condition wrong breaks dead-link detection:
 * the OS takes bytes into its send buffer whether or not the peer is still
 * there, so on a half-open link our own few-byte pings "leave" forever. What
 * the OS cannot do on a dead link is make ROOM — only the peer's ACKs free
 * send-buffer space. So outbound movement counts only if data was already
 * backed up in our process at the previous tick (the OS buffer was full) and
 * the OS has taken more of it since.
 *
 * "Taken more" cannot be read off `bufferedAmount` either. That number drops
 * only when a whole socket write completes, and one frame is one write: a
 * multi-megabyte proxy response on a 2 Mbit/s uplink needs longer than two
 * keep-alive intervals to leave, and `bufferedAmount` sits still the whole
 * time. Two counters, together exact:
 *   - flushed (bytesWritten - writableLength) grows when a write completes;
 *   - the libuv write queue shrinks while a write is partway through.
 * A new write starts only after the previous one completed, so the queue can
 * only grow when `flushed` did — neither moves without bytes leaving.
 */
export function linkMadeProgress(s: LinkSample): boolean {
  if (s.pongReceived || s.inboundActivity) return true
  if (s.pendingBefore <= 0) return false
  if (s.flushedNow > s.flushedBefore) return true
  return s.osQueueBefore !== undefined && s.osQueueNow !== undefined && s.osQueueNow < s.osQueueBefore
}

/** Outbound counters of a raw socket — see linkMadeProgress. */
function outboundCounters(socket: Socket | null): { pending: number; flushed: number; osQueue?: number } {
  if (!socket) return { pending: 0, flushed: 0 }
  // `_handle.writeQueueSize` is libuv's own count, exposed by Node's stream
  // wrap on every version this runs on (checked on 18 and 26). Read defensively:
  // without it only whole-frame progress is seen — still correct, just coarser.
  const handle = (socket as unknown as { _handle?: { writeQueueSize?: unknown } | null })._handle
  const osQueue = typeof handle?.writeQueueSize === 'number' ? handle.writeQueueSize : undefined
  return { pending: socket.writableLength, flushed: socket.bytesWritten - socket.writableLength, osQueue }
}

/**
 * WebSocket client for the relay's /bridge endpoint.
 *
 * After connect() the socket carries (see relay/src/ws/bridge.ts):
 *   relay → bridge: { type: 'hello', features }  (first frame; newer relays only)
 *   relay → bridge: { type: 'proxy', request_id, method, path, body? }
 *   bridge → relay: { type: 'proxy_response', request_id, status, contentType, nextCursor?, body }
 *                   or, once the hello offered 'gzip-body', a binary frame
 *                   (see sendProxyResponse)
 *   bridge → relay: { type: 'event', data }  (from startEventForwarding)
 */
export class RelayWSClient {
  private ws: WebSocket | null = null
  private eventAbortController: AbortController | null = null
  private boundSessionId: string | null = null
  private bridgeToken: string | null = null
  /** Directory of the shared session; scopes the opencode event stream. */
  private sessionDirectory: string | undefined
  /** Set by close(): stops the keep-alive and every retry loop for good. */
  private stopped = false
  /** Set when the relay rejected us — retrying can never succeed. */
  private fatal = false
  private keepAlive: NodeJS.Timeout | null = null
  /** Liveness evidence gathered since the last keep-alive tick — see linkMadeProgress. */
  private pongSinceTick = false
  private inboundSinceTick = false
  /** The socket under the current WebSocket — its counters measure outbound progress. */
  private rawSocket: Socket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private forwardingEvents = false
  /** The relay on the CURRENT socket said it accepts gzipped response bodies. */
  private relayAcceptsGzip = false
  /** Called when the relay rejects our credentials — the share is gone. */
  onFatal: ((err: Error) => void) | null = null
  /** Test/diagnostic hook: fired after every successful (re)connection. */
  onReconnect: (() => void) | null = null

  constructor(
    public relayUrl: string,
    private opencode: OpencodeClient,
  ) {}

  /**
   * Connect to the relay's /bridge endpoint. Resolves once the socket is
   * open; rejects if the relay refuses the credentials (close 4003) or the
   * connection fails before opening.
   */
  connect(session_id: string, bridge_token: string, directory?: string): Promise<void> {
    this.boundSessionId = session_id
    this.bridgeToken = bridge_token
    // Scopes the /event subscription — see OpencodeClient.getEvent.
    this.sessionDirectory = directory
    return this.dial()
  }

  /** Open one socket and wire keep-alive + reconnect onto it. */
  private dial(): Promise<void> {
    const session_id = this.boundSessionId!
    const base = this.relayUrl.replace(/^http/, 'ws')
    const url = `${base}/bridge?session_id=${encodeURIComponent(session_id)}`
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { 'x-bridge-token': this.bridgeToken! },
        // Nothing else watches a socket that has not opened: keep-alive starts
        // at 'open', ws sets no deadline unless asked, and the next re-dial is
        // only scheduled once this one fails. A dial whose bytes were delivered
        // but never answered (the laptop slept or switched networks right
        // after, a captive portal holding :443, an upgrade nginx accepted and
        // sat on) stayed CONNECTING for good, and the share with it, silently.
        // Timing out makes it an ordinary transport error the backoff retries.
        // ws clears the timeout once the upgrade succeeds, so an open link,
        // however quiet, is never cut by it.
        handshakeTimeout: wsHandshakeTimeoutMs(),
      })
      this.ws = ws
      // Per socket: a relay announces what it understands in its first frame,
      // and a reconnect may land on a different (older) relay.
      this.relayAcceptsGzip = false
      let opened = false
      ws.on('open', () => {
        opened = true
        this.reconnectAttempt = 0
        // Listen for raw bytes only now, never in 'upgrade'. There `ws` has not
        // attached its own reader yet and still has to hand back the bytes that
        // arrived with the 101 response (socket.unshift) — a 'data' listener
        // added first switches the socket to flowing and receives those bytes
        // ALONE, so the relay's first frames silently vanished.
        this.rawSocket?.on('data', () => {
          if (this.ws === ws) this.inboundSinceTick = true
        })
        this.startKeepAlive(ws)
        resolve()
      })
      ws.on('pong', () => {
        this.pongSinceTick = true
      })
      // Anything arriving from the relay proves the path works, whether or not
      // our own ping has been answered: its pings here, and raw bytes (see
      // 'open') so a large frame still in transit — a viewer posting a big
      // prompt over a slow downlink — counts as life before it is complete.
      ws.on('ping', () => {
        this.inboundSinceTick = true
      })
      ws.on('upgrade', (res) => {
        this.rawSocket = res.socket
      })
      // The relay refuses the UPGRADE (HTTP 401) when the session is gone —
      // it was stopped elsewhere, or the relay restarted and lost it. Every
      // re-dial would be refused the same way, so this ends the share instead
      // of looping. Transport failures stay retryable: that is the point.
      // Note: with a listener attached, ws stops emitting 'error' for this
      // case and leaves the socket to us — so settle and tear down here.
      ws.on('unexpected-response', (_req, res) => {
        const status = res.statusCode ?? 0
        const err = new Error(`relay rejected the bridge (HTTP ${status})`)
        if (status === 401 || status === 403) {
          this.fatal = true
          this.onFatal?.(err)
        }
        res.resume()
        ws.terminate()
        if (this.ws === ws) this.ws = null
        if (!opened) reject(err)
        else if (!this.fatal) this.scheduleReconnect()
      })
      ws.on('error', (err) => {
        if (!opened) reject(err)
      })
      ws.on('close', (code) => {
        if (!opened) {
          reject(new Error(`relay refused bridge connection (close code ${code})`))
          return
        }
        if (this.ws !== ws) return
        this.ws = null
        this.stopKeepAlive()
        // 4001/4003 mean the relay dropped us on purpose (session closed or
        // credentials rejected): re-dialling would loop forever.
        if (code === 4001 || code === 4003) {
          this.fatal = true
          this.onFatal?.(new Error(`relay closed the bridge (code ${code})`))
          return
        }
        this.scheduleReconnect()
      })
      ws.on('message', (raw) => {
        // Never fire-and-forget: an unhandled rejection ends the Node process,
        // so one frame this handler did not anticipate would take the share down.
        this.onMessage(raw).catch(warnFailedRelayMessage)
      })
    })
  }

  /**
   * Prove the link is alive — by PROGRESS, not by pongs alone.
   *
   * A half-open socket still reports OPEN, so something has to notice when the
   * network is gone. But a saturated uplink is not a gone network, and treating
   * it as one was the bug: our ping is written to the same socket as the data,
   * so behind megabytes of queued transcript it simply never reaches the relay
   * in time. No pong can come back, bytes keep leaving the whole while, and the
   * old rule — no pong by the next tick means dead — terminated a working link
   * and discarded every request in flight (the viewer's 502 "proxy failed").
   *
   * So a tick asks whether ANYTHING happened: an answer to our ping, any
   * traffic from the relay, or a backed-up send queue that the peer's ACKs are
   * still draining. Only KEEPALIVE_STRIKES consecutive ticks with none of those
   * end the socket — the same two intervals a truly silent link took to detect
   * before, so dead links are caught no later than they were.
   */
  private startKeepAlive(ws: WebSocket): void {
    this.stopKeepAlive()
    const socket = this.rawSocket
    let strikes = 0
    let last = outboundCounters(socket)
    const openedAt = Date.now()
    const timer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return
      const now = outboundCounters(socket)
      const progress = linkMadeProgress({
        pongReceived: this.pongSinceTick,
        inboundActivity: this.inboundSinceTick,
        pendingBefore: last.pending,
        flushedBefore: last.flushed,
        flushedNow: now.flushed,
        osQueueBefore: last.osQueue,
        osQueueNow: now.osQueue,
      })
      this.pongSinceTick = false
      this.inboundSinceTick = false
      last = now
      if (progress) {
        strikes = 0
      } else if (++strikes >= KEEPALIVE_STRIKES) {
        // Logged because the alternative is a share that silently cycles: this
        // line, with the queue size, is what tells "dead" from "congested".
        console.warn(
          `bridge: relay link silent for ${strikes} keep-alive intervals ` +
            `(up ${Math.round((Date.now() - openedAt) / 1000)}s, ${ws.bufferedAmount} bytes queued) — reconnecting`,
        )
        ws.terminate()
        return
      }
      try {
        ws.ping()
      } catch {
        ws.terminate()
      }
    }, wsPingIntervalMs())
    timer.unref?.()
    this.keepAlive = timer
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.keepAlive = null
    this.pongSinceTick = false
    this.inboundSinceTick = false
  }

  /** Re-dial with exponential backoff until it works or close() is called. */
  private scheduleReconnect(): void {
    if (this.stopped || this.fatal || this.reconnectTimer) return
    this.reconnectAttempt += 1
    const timer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped || this.fatal) return
      this.dial()
        .then(() => {
          // The event stream is per-connection state on the relay side: a new
          // socket has no subscribers until we push again, and the local SSE
          // reader may have ended while we were offline.
          // Never fire-and-forget: opencode may be unreachable right now (it
          // restarts, the machine wakes up), and an unhandled rejection ends
          // the Node process — the share would die on the very blip this
          // reconnect exists to survive. Failures retry like any lost stream.
          if (!this.forwardingEvents) this.startEventForwarding().catch(() => this.scheduleEventRestart())
          this.onReconnect?.()
        })
        .catch((err) => {
          warnFailedRedial(this.reconnectAttempt, err)
          this.scheduleReconnect()
        })
    }, backoffDelay(this.reconnectAttempt))
    timer.unref?.()
    this.reconnectTimer = timer
  }

  /**
   * Subscribe to opencode's /event SSE stream and push each event to the
   * relay. The stream ends whenever the local server restarts or the read
   * fails, so it re-subscribes until close() — otherwise the share would stay
   * connected but silent, with no events reaching any viewer.
   */
  async startEventForwarding(): Promise<void> {
    this.eventAbortController = new AbortController()
    const stream = await this.opencode.getEvent(this.eventAbortController.signal, this.sessionDirectory)
    if (!stream) throw new Error('opencode /event stream unavailable')
    this.forwardingEvents = true
    void readSseStream(
      stream,
      (data) => this.send({ type: 'event', data }),
      () => this.waitForSendRoom(),
    ).finally(() => {
      this.forwardingEvents = false
      this.scheduleEventRestart()
    })
  }

  /**
   * Backpressure for event forwarding: resolves once the relay socket's send
   * queue is below the high-water mark.
   *
   * Without it the queue had no bound at all. opencode emits events as fast as
   * the model writes, a home uplink carries ~2 Mbit/s, and everything that did
   * not fit piled up in this process — 4.5 MB was measured in the field. Every
   * viewer request answered meanwhile queued behind that pile, so a click on
   * the iPad waited for megabytes of old events to leave first. Pausing the
   * read pushes the wait back to opencode's stream, where it costs nothing,
   * and keeps request answers a bounded few seconds from the front.
   *
   * With no open socket there is nothing to wait for: send() drops events
   * while offline, exactly as before.
   */
  private async waitForSendRoom(): Promise<void> {
    const highWater = eventHighWaterBytes()
    for (;;) {
      const ws = this.ws
      if (this.stopped || !ws || ws.readyState !== WebSocket.OPEN) return
      if (ws.bufferedAmount < highWater) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  private scheduleEventRestart(): void {
    if (this.stopped) return
    const timer = setTimeout(() => {
      if (this.stopped || this.forwardingEvents) return
      this.startEventForwarding().catch(() => this.scheduleEventRestart())
    }, eventRetryMs())
    timer.unref?.()
  }

  close() {
    this.stopped = true
    this.stopKeepAlive()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.eventAbortController?.abort()
    this.eventAbortController = null
    this.ws?.close()
  }

  private async onMessage(raw: WebSocket.RawData): Promise<void> {
    let msg: { type?: string; request_id?: string; method?: unknown; path?: unknown; body?: unknown }
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (msg.type === 'hello') {
      const features = (msg as { features?: unknown }).features
      this.relayAcceptsGzip = Array.isArray(features) && features.includes('gzip-body')
      return
    }
    if (msg.type !== 'proxy' || typeof msg.request_id !== 'string') return
    const method: unknown = msg.method ?? 'GET'
    const path: unknown = msg.path ?? '/'
    // Check before opencode is touched at all: the relay does not get to pick
    // which verb runs against which local endpoint (see RELAY_PROXY_ROUTES).
    // Types first — both come off the wire from a relay this bridge does not
    // trust, and the allowlist calls string methods on them.
    if (typeof method !== 'string' || typeof path !== 'string' || !isProxyRequestAllowed(method, path, this.boundSessionId)) {
      warnRejectedProxyRequest(
        typeof method === 'string' ? method : `<${typeof method}>`,
        typeof path === 'string' ? path : `<${typeof path}>`,
      )
      this.send({
        type: 'proxy_response',
        request_id: msg.request_id,
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'path not allowed by bridge' }),
      })
      return
    }
    try {
      const guardError = await this.guardRequest(method, path)
      if (guardError) {
        this.send({
          type: 'proxy_response',
          request_id: msg.request_id,
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: guardError }),
        })
        return
      }
      const out = await this.opencode.request(method, path, msg.body)
      await this.sendProxyResponse(msg.request_id, out)
    } catch {
      this.send({
        type: 'proxy_response',
        request_id: msg.request_id,
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'opencode unreachable' }),
      })
    }
  }

  /**
   * Answer a proxy request, gzipping the body when that is worth it.
   *
   * The owner's uplink is the narrowest pipe in the whole path — the field
   * incident was a ~2 Mbit/s home line — and what crosses it is mostly JSON
   * transcript, which compresses 3-10x. Sent as a binary frame the relay only
   * accepts after announcing support (see its hello). A body that compresses
   * better than the relay's inflate limit goes uncompressed: the relay would
   * rightly refuse to expand it.
   */
  private async sendProxyResponse(
    request_id: string,
    out: { status: number; contentType?: string; nextCursor?: string; body: string },
  ): Promise<void> {
    if (this.relayAcceptsGzip && out.body.length >= GZIP_MIN_BYTES) {
      const raw = Buffer.from(out.body, 'utf8')
      const compressed = await new Promise<Buffer | null>((resolve) =>
        gzip(raw, (err, result) => resolve(err ? null : result)),
      )
      const worthIt =
        compressed !== null &&
        compressed.length < raw.length * 0.9 &&
        raw.length <= compressed.length * GZIP_MAX_RATIO &&
        raw.length <= GZIP_MAX_OUTPUT_BYTES
      // Re-checked after the await: the socket may have been replaced by one
      // whose relay has not (or not yet) announced support.
      if (worthIt && this.relayAcceptsGzip && this.ws?.readyState === WebSocket.OPEN) {
        const header = Buffer.from(
          JSON.stringify({
            type: 'proxy_response',
            request_id,
            status: out.status,
            contentType: out.contentType,
            nextCursor: out.nextCursor,
            encoding: 'gzip',
          }),
        )
        const prefix = Buffer.alloc(4)
        prefix.writeUInt32BE(header.length, 0)
        this.ws.send(Buffer.concat([prefix, header, compressed!]), { binary: true })
        return
      }
    }
    this.send({ type: 'proxy_response', request_id, ...out })
  }

  private send(data: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data))
  }

  /**
   * Cross-session guard. The relay force-binds the URL :id to the viewer's
   * session, but upstream opencode's permission reply endpoint does NOT
   * check that the permission request belongs to that session — a viewer
   * could approve a prompt raised by ANOTHER session of the owner. Verify
   * the permission request belongs to the bound session, or to one of its
   * subagents (see sharesTree), before forwarding. Question replies and
   * rejections are checked the same way (see guardQuestion).
   */
  private async guardRequest(method: string, path: string): Promise<string | null> {
    // The relay always appends its own ?directory=… query to the forwarded
    // path, so match the pathname only — otherwise the query lands inside the
    // captured permission id and every viewer reply is rejected as foreign.
    const pathname = path.split(/[?#]/)[0]!
    if (method !== 'POST') return null
    // Both dialects: the allowlist admits the '/api' twin of every route, and
    // a guard that only knew the bare spelling would wave that one through.
    // The permission route used to be matched bare only, so its /api twin
    // skipped the ownership check (opencode 1.18.30 does not route that
    // spelling, but the allowlist lets it through to whatever server does).
    const question = /^(?:\/api)?\/question\/([^/]+)\/(?:reply|reject)$/.exec(pathname)
    if (question) return this.guardQuestion(decodeURIComponent(question[1]!), path)
    const m = /^(?:\/api)?\/session\/[^/]+\/permissions\/([^/]+)$/.exec(pathname)
    if (!m) return null
    const permissionID = decodeURIComponent(m[1]!)
    if (!this.boundSessionId) return null
    const query = queryOfPath(path)
    try {
      // Listed with the forwarded request's own query, like guardQuestion:
      // pending permissions are held per directory instance, and a list
      // without ?directory=… reads the server's own one. That found nothing
      // whenever the shared session lived elsewhere (the desktop app hosting
      // several projects, a server started from another folder), so every
      // viewer answer was refused as foreign.
      const pending = await this.opencode.listPermissions(query)
      const list = Array.isArray(pending) ? pending : []
      for (const p of list) {
        const rec = p as Record<string, unknown> | null
        if (rec?.id !== permissionID && rec?.requestID !== permissionID) continue
        if (await this.sharesTree(rec.sessionID, query)) return null
      }
      return 'permission request not found for this session'
    } catch {
      // If we cannot verify, fail closed.
      return 'permission verification unavailable'
    }
  }

  /**
   * Answer or dismiss only a question of the bound session or its subagents.
   *
   * opencode's POST /question/:requestID/reply and /reject take nothing but
   * the id and act on whichever pending question has it, from any session —
   * so without this a viewer, or a hostile relay, could answer or dismiss a
   * question the agent put to the owner in another session. The pending list
   * is read with the forwarded request's own query: questions are held per
   * instance (the ?directory=… the relay pins), and that is the instance the
   * reply will act on. Anything that does not prove ownership is refused.
   */
  private async guardQuestion(requestID: string, path: string): Promise<string | null> {
    const notFound = 'question request not found for this session'
    if (!this.boundSessionId) return 'question verification unavailable'
    const query = queryOfPath(path)
    try {
      const pending: unknown = await this.opencode.listQuestions(query)
      if (!Array.isArray(pending)) return notFound
      for (const q of pending) {
        const rec = q as Record<string, unknown> | null
        if (rec?.id !== requestID) continue
        if (await this.sharesTree(rec.sessionID, query)) return null
      }
      return notFound
    } catch {
      // If we cannot verify, fail closed.
      return 'question verification unavailable'
    }
  }

  /**
   * Whether a pending request of `sessionID` belongs to the share: the bound
   * session itself, or a subagent of it at any depth.
   *
   * The task tool runs a subagent in a child session (parentID = the session
   * that started it), and the permission or question the subagent needs
   * carries the CHILD's id — measured on opencode 1.18.30. While it is pending
   * the parent waits on it, so refusing it (as the guards did when they
   * compared with the bound id alone) left a viewer-driven share blocked until
   * the owner answered locally.
   *
   * Proven by walking parentID through the local opencode, in the forwarded
   * request's own instance, up to the bound session. Anything that does not
   * prove it is not: a detail that cannot be read or does not echo its own id,
   * a root that is not ours, a loop, or a chain deeper than any real nesting.
   */
  private async sharesTree(sessionID: unknown, query: string): Promise<boolean> {
    const bound = this.boundSessionId
    if (!bound || typeof sessionID !== 'string') return false
    if (sessionID === bound) return true
    const seen = new Set<string>()
    let current = sessionID
    for (let hop = 0; hop < MAX_SUBAGENT_DEPTH; hop++) {
      if (!SESSION_ID_RE.test(current) || seen.has(current)) return false
      seen.add(current)
      let detail: { id?: unknown; parentID?: unknown } | null
      try {
        detail = (await this.opencode.getSession(current, query)) as typeof detail
      } catch {
        return false
      }
      if (detail?.id !== current || typeof detail.parentID !== 'string') return false
      if (detail.parentID === bound) return true
      current = detail.parentID
    }
    return false
  }
}

/**
 * Minimal SSE reader: splits the stream into events and hands each `data:`
 * payload to onEvent. Multi-line data fields are joined with \n per the
 * SSE spec. Read errors (e.g. opencode going away) end the stream quietly —
 * the bridge watchdog (later task) owns reconnect/exit policy.
 */
async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (data: string) => void,
  waitForRoom: () => Promise<void> = async () => {},
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      await waitForRoom()
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = chunk
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (data) onEvent(data)
      }
    }
  } catch {
    // stream errored: nothing to forward anymore
  } finally {
    reader.releaseLock()
  }
}
