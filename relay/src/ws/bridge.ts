import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Store } from '../store.js'
import { wsPingIntervalMs, wsPongGraceRounds } from '../config.js'

/**
 * Relay-side hub for bridge WebSocket connections at /bridge.
 *
 * A bridge authenticates with ?session_id&token (its bridge_token, verified
 * against the salted hash in the store). Afterwards the socket carries:
 *
 *   relay → bridge: { type: 'proxy', request_id, method, path, body? }
 *   bridge → relay: { type: 'proxy_response', request_id, status, contentType, body }
 *   bridge → relay: { type: 'event', data }   (opencode SSE event, re-emitted
 *                                            to viewers by the SSE endpoint)
 */

export interface ProxyRequest {
  method: string
  path: string
  body?: unknown
}

export interface ProxyResponse {
  status: number
  contentType?: string
  body: string
}

interface PendingRequest {
  session_id: string
  resolve: (value: ProxyResponse) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class BridgeClient {
  private wss: WebSocketServer
  private clients: Map<string, WebSocket> = new Map()
  private pending: Map<string, PendingRequest> = new Map()
  private eventListeners: Map<string, Set<(data: string) => void>> = new Map()
  /** Ping rounds a socket has gone without answering (reset by every pong). */
  private missedPongs: WeakMap<WebSocket, number> = new WeakMap()
  private keepAlive: NodeJS.Timeout

  constructor(server: Server, private store: Store) {
    this.wss = new WebSocketServer({
      server,
      path: '/bridge',
      // Reject bad credentials during the upgrade (HTTP 401) so no socket
      // is ever established; the store lookup is synchronous.
      verifyClient: (info, done) => {
        const url = new URL(info.req.url ?? '', 'http://localhost')
        const session_id = url.searchParams.get('session_id') ?? ''
        // Accept token from header (preferred, avoids nginx access logs) or
        // legacy query param (deprecated, will be removed).
        const headerToken = info.req.headers['x-bridge-token']
        const token = (typeof headerToken === 'string' ? headerToken : url.searchParams.get('token')) ?? ''
        done(this.store.verifyBridgeToken(session_id, token))
      },
    })
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      const session_id = url.searchParams.get('session_id') ?? ''
      const headerToken = req.headers['x-bridge-token']
      const token = (typeof headerToken === 'string' ? headerToken : url.searchParams.get('token')) ?? ''
      if (!this.store.verifyBridgeToken(session_id, token)) {
        ws.close(4003, 'invalid bridge token')
        return
      }
      // One bridge per session: a reconnect replaces the old socket.
      this.clients.get(session_id)?.terminate()
      this.clients.set(session_id, ws)
      this.missedPongs.set(ws, 0)
      // A pong is proof the bridge is reachable — and proof the share is in
      // use, so it also keeps the orphan reaper away from an idle session.
      ws.on('pong', () => {
        this.missedPongs.set(ws, 0)
        this.store.touchSession(session_id)
      })
      ws.on('message', (raw) => this.onMessage(session_id, raw))
      ws.on('close', () => {
        if (this.clients.get(session_id) === ws) {
          this.clients.delete(session_id)
          // Fail all pending requests for this session early, instead of
          // letting viewers wait the full timeout for a 504.
          this.failPending(session_id, 'bridge closed')
        }
      })
    })
    // Half-open sockets look OPEN forever: without this sweep a bridge that
    // dropped off the network keeps its session slot and every viewer request
    // waits out the full proxy timeout.
    this.keepAlive = setInterval(() => this.pingClients(), wsPingIntervalMs())
    this.keepAlive.unref?.()
  }

  /** One keep-alive round: drop silent sockets, ping the rest. */
  private pingClients(): void {
    const grace = wsPongGraceRounds()
    for (const [session_id, ws] of this.clients.entries()) {
      if (ws.readyState !== WebSocket.OPEN) continue
      const missed = (this.missedPongs.get(ws) ?? 0) + 1
      if (missed > grace) {
        // Terminate, never close(): a half-open socket never answers the
        // closing handshake. 'close' fires and fails its pending requests.
        this.clients.delete(session_id)
        this.failPending(session_id, 'bridge unreachable')
        ws.terminate()
        continue
      }
      this.missedPongs.set(ws, missed)
      try {
        ws.ping()
      } catch {
        // Socket died between the readyState check and the ping.
      }
    }
  }

  /** Reject every in-flight proxy request of one session. */
  private failPending(session_id: string, reason: string): void {
    for (const [request_id, pending] of this.pending.entries()) {
      if (pending.session_id !== session_id) continue
      clearTimeout(pending.timer)
      this.pending.delete(request_id)
      pending.reject(new Error(reason))
    }
  }

  isConnected(session_id: string): boolean {
    return this.clients.get(session_id)?.readyState === WebSocket.OPEN
  }

  /**
   * Send a proxy request to the session's bridge and wait for its response.
   * Rejects with 'bridge not connected' or 'proxy timeout'.
   */
  request(session_id: string, req: ProxyRequest, timeoutMs: number): Promise<ProxyResponse> {
    const ws = this.clients.get(session_id)
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('bridge not connected'))
    }
    // Active traffic keeps the share alive against the orphan reaper.
    this.store.touchSession(session_id)
    const request_id = randomUUID()
    return new Promise<ProxyResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id)
        reject(new Error('proxy timeout'))
      }, timeoutMs)
      this.pending.set(request_id, { session_id, resolve, reject, timer })
      ws.send(JSON.stringify({ type: 'proxy', request_id, ...req }))
    })
  }

  /**
   * Subscribe to opencode events for a session (pushed by the bridge).
   * Returns an unsubscribe function.
   */
  subscribeEvents(session_id: string, listener: (data: string) => void): () => void {
    let set = this.eventListeners.get(session_id)
    if (!set) {
      set = new Set()
      this.eventListeners.set(session_id, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.eventListeners.delete(session_id)
    }
  }

  /**
   * Drop one session's bridge connection (session stopped): close the socket
   * and fail its pending proxy requests. No-op when no bridge is connected.
   */
  disconnect(session_id: string): void {
    const ws = this.clients.get(session_id)
    if (!ws) return
    this.clients.delete(session_id)
    for (const [request_id, pending] of this.pending.entries()) {
      if (pending.session_id === session_id) {
        clearTimeout(pending.timer)
        this.pending.delete(request_id)
        pending.reject(new Error('session closed'))
      }
    }
    ws.close(4001, 'session closed')
  }

  /** Close all bridge connections and fail every pending proxy request. */
  close() {
    clearInterval(this.keepAlive)
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error('bridge closed'))
    }
    this.pending.clear()
    for (const ws of this.clients.values()) ws.terminate()
    this.clients.clear()
    this.wss.close()
  }

  private onMessage(session_id: string, raw: WebSocket.RawData) {
    let msg: { type?: string; request_id?: string; data?: string } & Partial<ProxyResponse>
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (msg.type === 'proxy_response' && typeof msg.request_id === 'string') {
      const pending = this.pending.get(msg.request_id)
      if (!pending) return
      this.pending.delete(msg.request_id)
      clearTimeout(pending.timer)
      pending.resolve({
        status: typeof msg.status === 'number' ? msg.status : 502,
        contentType: typeof msg.contentType === 'string' ? msg.contentType : undefined,
        body: typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body ?? null),
      })
      return
    }
    if (msg.type === 'event' && typeof msg.data === 'string') {
      for (const listener of this.eventListeners.get(session_id) ?? []) listener(msg.data)
    }
  }
}
