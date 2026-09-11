import WebSocket from 'ws'
import type { OpencodeClient } from './opencode.js'
import { backoffDelay, eventRetryMs, wsPingIntervalMs } from './config.js'

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

  /** Register a session; secrets (access_code, bridge_token) return once. */
  async createSession(
    sessionId: string,
    directory: string,
    title: string,
  ): Promise<RelaySession> {
    const res = await fetch(`${this.url}/api/sessions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ session_id: sessionId, directory, title }),
    })
    if (!res.ok) throw new Error(`relay createSession failed: ${res.status}`)
    return (await res.json()) as RelaySession
  }

  /** End a session on the relay. Requires the session's own bridge_token. */
  async deleteSession(sessionId: string, bridgeToken: string): Promise<number> {
    const res = await fetch(`${this.url}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { ...this.headers(), 'x-bridge-token': bridgeToken },
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
 * template (`/project`, `/project/current`, `/permission`, `/session/status`,
 * and `/session/<ses_…>` from the subagent ancestry walk). Each entry also
 * covers its `/api/…` twin — the opencode web UI speaks both dialects against
 * the same server and the relay mounts both.
 *
 * ':id' stands for a session id; ':messageID' / ':permissionID' stand for one
 * opaque path segment (the relay percent-encodes them).
 */
const RELAY_PROXY_ROUTES: ReadonlyArray<readonly [ProxyMethod, string]> = [
  // Session detail + messages (relay ALLOWED_ROUTES; ':id' is the viewer's
  // bound session or one of its subagents on the child-readable routes).
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
  // Question / resource / reference APIs the UI bootstrap resolves.
  ['GET', '/question'],
  ['POST', '/question'],
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

/** method+path pairs already reported, so one confused relay cannot spam the
 * log (and cannot grow this set without bound either). */
const warnedRejections = new Set<string>()
const MAX_LOGGED_REJECTIONS = 50

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
 * WebSocket client for the relay's /bridge endpoint.
 *
 * After connect() the socket carries (see relay/src/ws/bridge.ts):
 *   relay → bridge: { type: 'proxy', request_id, method, path, body? }
 *   bridge → relay: { type: 'proxy_response', request_id, status, contentType, body }
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
  private awaitingPong = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private forwardingEvents = false
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
      })
      this.ws = ws
      let opened = false
      ws.on('open', () => {
        opened = true
        this.reconnectAttempt = 0
        this.startKeepAlive(ws)
        resolve()
      })
      ws.on('pong', () => {
        this.awaitingPong = false
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
        void this.onMessage(raw)
      })
    })
  }

  /**
   * Prove the link in both directions. A half-open socket still reports OPEN,
   * so an unanswered ping is the only way to notice the network went away:
   * terminate() then fires 'close' and starts the reconnect.
   */
  private startKeepAlive(ws: WebSocket): void {
    this.stopKeepAlive()
    this.awaitingPong = false
    const timer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return
      if (this.awaitingPong) {
        ws.terminate()
        return
      }
      this.awaitingPong = true
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
    this.awaitingPong = false
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
          if (!this.forwardingEvents) void this.startEventForwarding()
          this.onReconnect?.()
        })
        .catch(() => this.scheduleReconnect())
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
    void readSseStream(stream, (data) => this.send({ type: 'event', data })).finally(() => {
      this.forwardingEvents = false
      this.scheduleEventRestart()
    })
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
    let msg: { type?: string; request_id?: string; method?: string; path?: string; body?: unknown }
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (msg.type !== 'proxy' || typeof msg.request_id !== 'string') return
    const method = msg.method ?? 'GET'
    const path = msg.path ?? '/'
    // Check before opencode is touched at all: the relay does not get to pick
    // which verb runs against which local endpoint (see RELAY_PROXY_ROUTES).
    if (!isProxyRequestAllowed(method, path, this.boundSessionId)) {
      warnRejectedProxyRequest(method, path)
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
      this.send({ type: 'proxy_response', request_id: msg.request_id, ...out })
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

  private send(data: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(data))
  }

  /**
   * Cross-session guard. The relay force-binds the URL :id to the viewer's
   * session, but upstream opencode's permission reply endpoint does NOT
   * check that the permission request belongs to that session — a viewer
   * could approve a prompt raised by ANOTHER session of the owner. Verify
   * the permission request belongs to the bound session before forwarding.
   */
  private async guardRequest(method: string, path: string): Promise<string | null> {
    // The relay always appends its own ?directory=… query to the forwarded
    // path, so match the pathname only — otherwise the query lands inside the
    // captured permission id and every viewer reply is rejected as foreign.
    const pathname = path.split(/[?#]/)[0]!
    const m = /^\/session\/[^/]+\/permissions\/([^/]+)$/.exec(pathname)
    if (method !== 'POST' || !m) return null
    const permissionID = decodeURIComponent(m[1]!)
    if (!this.boundSessionId) return null
    try {
      const pending = await this.opencode.listPermissions()
      const list = Array.isArray(pending) ? pending : []
      const owned = list.some((p) => {
        const rec = p as Record<string, unknown>
        return (rec.id === permissionID || rec.requestID === permissionID) && rec.sessionID === this.boundSessionId
      })
      return owned ? null : 'permission request not found for this session'
    } catch {
      // If we cannot verify, fail closed.
      return 'permission verification unavailable'
    }
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
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
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
