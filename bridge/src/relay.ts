import WebSocket from 'ws'
import type { OpencodeClient } from './opencode.js'
import { backoffDelay, eventRetryMs, wsPingIntervalMs } from './config.js'

/**
 * Client for the public relay's bridge-facing session API.
 * Every request carries the shared relay secret in `x-api-key`
 * (DELETE requires it per the design spec; POST is expected to be guarded
 * by it in a later relay hardening task, so it is sent there too).
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
  directory: string
  title: string
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
  async getSession(sessionId: string): Promise<{ status: number; body?: SessionStatus }> {
    const res = await fetch(`${this.url}/api/sessions/${encodeURIComponent(sessionId)}`, {
      headers: this.headers(),
    })
    if (res.status !== 200) return { status: res.status }
    return { status: 200, body: (await res.json()) as SessionStatus }
  }
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
  connect(session_id: string, bridge_token: string): Promise<void> {
    this.boundSessionId = session_id
    this.bridgeToken = bridge_token
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
    const stream = await this.opencode.getEvent(this.eventAbortController.signal)
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
    try {
      const guardError = await this.guardRequest(msg.method ?? 'GET', msg.path ?? '/')
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
      const out = await this.opencode.request(msg.method ?? 'GET', msg.path ?? '/', msg.body)
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
