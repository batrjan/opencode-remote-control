import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { gunzip } from 'node:zlib'
import type { Session, Store } from '../store.js'
import { bridgeReconnectWaitMs, wsPingIntervalMs, wsPongGraceRounds } from '../config.js'

/**
 * Relay-side hub for bridge WebSocket connections at /bridge.
 *
 * A bridge authenticates with ?session_id&token (its bridge_token, verified
 * against the salted hash in the store). Afterwards the socket carries:
 *
 *   relay → bridge: { type: 'proxy', request_id, method, path, body? }
 *   bridge → relay: { type: 'proxy_response', request_id, status, contentType, nextCursor?, body }
 *   bridge → relay: { type: 'event', data }   (opencode SSE event, re-emitted
 *                                            to viewers by the SSE endpoint)
 *   relay → bridge: { type: 'hello', features: ['gzip-body'] }   (first frame)
 *   bridge → relay: binary [u32 header length][header JSON][gzip body], header
 *                   { type: 'proxy_response', request_id, status, contentType,
 *                     nextCursor?, encoding: 'gzip' }   — only after the hello;
 *                   see onCompressedResponse
 *
 * nextCursor is opencode's X-Next-Cursor (see ProxyResponse). An older bridge
 * never sends it and an older relay ignores it.
 */

/**
 * The most a compressed response body may expand. Part of the protocol: the
 * bridge sends anything that compresses better than this uncompressed.
 *
 * Why there is a cap at all: registration is public, so a "bridge" can be
 * anyone, and without one a hundred kilobytes of gzip decompress to a hundred
 * megabytes of work on this process — a DoS for the price of a phone uplink.
 * Honest transcripts compress 3-10x; 32x leaves them all their savings while
 * bounding what one byte on the wire can cost the relay.
 */
export const GZIP_MAX_RATIO = 32
/** Never inflate past what an uncompressed frame could carry (ws default maxPayload). */
const GZIP_MAX_OUTPUT_BYTES = 100 * 1024 * 1024
/** Header JSON of a compressed frame is a few hundred bytes; anything larger is not ours. */
const GZIP_MAX_HEADER_BYTES = 16 * 1024

export interface ProxyRequest {
  method: string
  path: string
  body?: unknown
}

export interface ProxyResponse {
  status: number
  contentType?: string
  /**
   * opencode's X-Next-Cursor: the one place a paged transcript names its older
   * page (the body is a bare array). Already checked by nextCursorOf.
   */
  nextCursor?: string
  body: string
}

/**
 * A pagination cursor as opencode mints it: base64(url) of a small JSON
 * object, well under a hundred characters. The value comes from a bridge,
 * which can be anyone, and is reflected into the viewer's response headers —
 * so anything that is not a plain token of sane length is dropped rather than
 * forwarded (a CR/LF would inject a header or make the response throw).
 */
const NEXT_CURSOR_RE = /^[A-Za-z0-9_\-+/=.]{1,1024}$/

function nextCursorOf(value: unknown): string | undefined {
  return typeof value === 'string' && NEXT_CURSOR_RE.test(value) ? value : undefined
}

interface PendingRequest {
  session_id: string
  /**
   * The socket the request was sent on: when that socket goes, so does any
   * chance of an answer to what it had not yet delivered. Only failure is
   * bound to it — a bridge answers on whichever socket is current, so a
   * response is still matched by request_id and session alone.
   */
  ws: WebSocket
  resolve: (value: ProxyResponse) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class BridgeClient {
  private wss: WebSocketServer
  private clients: Map<string, WebSocket> = new Map()
  private pending: Map<string, PendingRequest> = new Map()
  private eventListeners: Map<string, Set<(data: string) => void>> = new Map()
  /** Ping rounds a socket has gone without a sign of life (reset by a pong or any inbound bytes). */
  private missedPongs: WeakMap<WebSocket, number> = new WeakMap()
  /** Lifecycle log budget — see logLifecycle. */
  private lifecycleLog = { windowStart: 0, lines: 0, suppressed: 0 }
  private static readonly LIFECYCLE_LOG_LINES_PER_MINUTE = 60
  /** (from, to) session pairs already logged — see warnCrossSession. */
  private crossSessionWarned: Set<string> = new Set()
  /** Hard cap so the set above cannot grow without bound either. */
  private static readonly MAX_CROSS_SESSION_WARNINGS = 100
  private keepAlive: NodeJS.Timeout
  /** Requests waiting for a session's bridge to (re)connect — see waitForConnection. */
  private connectWaiters: Map<string, Set<() => void>> = new Map()
  /** When each session's bridge last lost its link, while it has not come back. */
  private droppedAt: Map<string, number> = new Map()
  /** A drop older than this is an absent bridge, not one that is re-dialling. */
  private static readonly RECENT_DROP_MS = 60_000
  /** Told when a session's bridge comes back after losing its link — see onReconnect. */
  private reconnectListeners: Set<(session_id: string) => void> = new Set()

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
      const replaced = this.clients.get(session_id)
      // A re-dial, not a first connection: the old link either dropped or is
      // still here, dead, because the bridge noticed before the relay did.
      // Either way the bridge read opencode's events into the void meanwhile.
      const redial = replaced !== undefined || this.droppedAt.has(session_id)
      // Its 'close' fails what was still waiting on it (see below) once this
      // socket is current, so a GET caught in it is repeated on this one at
      // once and a lost prompt is looked for here.
      replaced?.terminate()
      this.clients.set(session_id, ws)
      this.droppedAt.delete(session_id)
      this.missedPongs.set(ws, 0)
      const connectedAt = Date.now()
      this.logLifecycle(`connected session=${JSON.stringify(session_id)}${replaced ? ' (replacing previous socket)' : ''}`)
      // The connection is the first sign of life, and what tells the store a
      // bridge took this registration up: until then the registration holds
      // its slot only briefly (config.unboundReapMs). Not left to the first
      // pong or byte: a bridge with nothing to send says nothing until the
      // first ping, a round after the connection.
      this.store.touchSession(session_id)
      // A pong is proof the bridge is reachable — and proof the share is in
      // use, so it also keeps the orphan reaper away from an idle session.
      // What a full relay ranks shares by moves only once the socket has
      // stayed a ping interval (see Store.evictDepartedShare): a connect, a
      // byte and a close cost nothing, and repeated they held a slot. Its age,
      // not our ping being answered: ws reports an unsolicited pong the same.
      const alive = () => {
        this.missedPongs.set(ws, 0)
        this.store.touchSession(session_id, Date.now() - connectedAt >= wsPingIntervalMs())
      }
      ws.on('pong', alive)
      // So is ANY byte from the bridge. Its pong travels on the same socket as
      // everything else it sends, so on a saturated uplink the pong waits
      // behind megabytes of transcript and arrives after the grace has run
      // out — and the relay used to drop a bridge that was delivering data the
      // whole time, failing every viewer request in flight. Raw bytes, not
      // messages: a large frame still in transit is life before it completes.
      req.socket.on('data', alive)
      // First frame, before any proxy request can be sent on this socket: what
      // this relay understands. Bridges that predate it ignore unknown types.
      ws.send(JSON.stringify({ type: 'hello', features: ['gzip-body'] }))
      ws.on('message', (raw, isBinary) => {
        if (isBinary) void this.onCompressedResponse(session_id, raw)
        else this.onMessage(session_id, raw)
      })
      // A socket with no 'error' listener makes `ws` rethrow, and an
      // unhandled 'error' on an EventEmitter takes the whole process down —
      // so one malformed frame (an unmasked client frame is three bytes) from
      // ANY authenticated bridge killed the relay and every other live share
      // with it. Registration is public, so that was a remote DoS for the
      // price of one session. Confine the protocol violation to its own
      // socket: terminate it, and let the 'close' handler below fail that
      // socket's pending requests the way any other disconnect does.
      ws.on('error', (err) => {
        console.warn(`[bridge] socket error session=${JSON.stringify(session_id)}: ${err.message}`)
        ws.terminate()
      })
      ws.on('close', (code) => {
        const current = this.clients.get(session_id) === ws
        if (current) {
          this.clients.delete(session_id)
          this.markDropped(session_id)
        }
        // Fail this socket's pending requests early, instead of letting
        // viewers wait the full timeout for a 504 — also when it was no longer
        // current. A bridge that notices a dead link before the relay does
        // re-dials, and its new socket replaces this one (see 'connection'):
        // nothing ever answers what was sent into the dead one, and a prompt
        // sat out its whole two-minute timeout before the relay even looked
        // for it (see the proxy adapter's promptLanded). Requests sent on the
        // new socket are that socket's own and stay.
        const failed = this.failPending(session_id, 'bridge closed', ws)
        this.logLifecycle(
          `disconnected session=${JSON.stringify(session_id)} code=${code} ` +
            `after ${Math.round((Date.now() - connectedAt) / 1000)}s` +
            (failed ? `, failed ${failed} in-flight request(s)` : '') +
            (current ? '' : ' (already detached)'),
        )
      })
      // Last, once the socket is fully wired: requests that were waiting out a
      // reconnect can go now.
      const waiters = this.connectWaiters.get(session_id)
      if (waiters) for (const wake of [...waiters]) wake()
      if (redial) this.notifyReconnect(session_id)
    })
    // Same reasoning one level up: an 'error' on the server itself (a failed
    // upgrade, a socket that dies mid-handshake before 'connection' fires) has
    // no per-socket listener to catch it, and would again be fatal.
    this.wss.on('error', (err) => {
      console.warn(`[bridge] websocket server error: ${err.message}`)
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
        this.markDropped(session_id)
        const failed = this.failPending(session_id, 'bridge unreachable', ws)
        this.logLifecycle(
          `no sign of life from session=${JSON.stringify(session_id)} for ${missed} ping rounds — terminating` +
            (failed ? `, failed ${failed} in-flight request(s)` : ''),
        )
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

  /**
   * Report a cross-session proxy_response once per (from, to) pair.
   *
   * The bare console.warn this replaces was reachable by anyone: two public
   * registrations give an attacker two bridges, and a loop of forged frames
   * then wrote attacker-chosen text into the relay's log as fast as the socket
   * allowed (~12 MB/s into an unrotated docker json-file log, with /health
   * latency going from 2 ms to ~50 ms) — and the session ids are attacker-
   * chosen, so the log could be salted with forged-looking lines. Log the
   * event, not the flood: the first occurrence of a pair is the signal, the
   * millionth is the attack. Ids are JSON-escaped so they cannot inject
   * newlines into the stream operators grep.
   */
  private warnCrossSession(from: string, to: string): void {
    const key = `${from}\u0000${to}`
    if (this.crossSessionWarned.has(key)) return
    if (this.crossSessionWarned.size >= BridgeClient.MAX_CROSS_SESSION_WARNINGS) return
    this.crossSessionWarned.add(key)
    console.warn(
      `[bridge] dropped proxy_response from session=${JSON.stringify(from)} for a request owned by session=${JSON.stringify(to)}`,
    )
  }

  /**
   * Reject every in-flight proxy request of one session — or, given `ws`, only
   * those sent on that socket; returns how many.
   */
  private failPending(session_id: string, reason: string, ws?: WebSocket): number {
    let failed = 0
    for (const [request_id, pending] of this.pending.entries()) {
      if (pending.session_id !== session_id) continue
      if (ws !== undefined && pending.ws !== ws) continue
      clearTimeout(pending.timer)
      this.pending.delete(request_id)
      pending.reject(new Error(reason))
      failed += 1
    }
    return failed
  }

  /**
   * Bridge connects, disconnects and keep-alive kills.
   *
   * These lines are how a share that keeps dropping gets diagnosed: when a
   * viewer reported repeated 502s, the relay had logged nothing at all, and
   * the cause had to be reconstructed from nginx's access log. Budgeted,
   * because connecting takes only a bridge token and registration is public —
   * a loop of reconnects must not be able to flood the log. What was dropped
   * is counted and reported, so a gap never looks like quiet.
   */
  private logLifecycle(line: string): void {
    const now = Date.now()
    const log = this.lifecycleLog
    if (now - log.windowStart >= 60_000) {
      if (log.suppressed) console.warn(`[bridge] (${log.suppressed} lifecycle line(s) suppressed in the last minute)`)
      log.windowStart = now
      log.lines = 0
      log.suppressed = 0
    }
    if (log.lines >= BridgeClient.LIFECYCLE_LOG_LINES_PER_MINUTE) {
      log.suppressed += 1
      return
    }
    log.lines += 1
    console.log(`[bridge] ${line}`)
  }

  isConnected(session_id: string): boolean {
    return this.clients.get(session_id)?.readyState === WebSocket.OPEN
  }

  /**
   * Send a proxy request to the session's bridge and wait for its response.
   * Rejects with 'bridge not connected', 'bridge closed', 'bridge unreachable',
   * 'session closed', 'bad compressed response' or 'proxy timeout'.
   *
   * A GET that failed only because the bridge's link dropped is sent once more
   * as soon as the bridge is back (within bridgeReconnectWaitMs). This is what
   * a viewer on a flaky owner uplink experiences as a pause instead of an
   * error: the bridge re-dials within about a second, but every request in
   * flight at the moment of the drop used to become a 502 "proxy failed".
   * Nothing else is repeated — not a POST (a prompt sent twice is not
   * harmless), not a timeout (the first attempt may still be running), not a
   * session that was stopped on purpose.
   *
   * The repeat goes only to the registration the request was made for (the
   * store's Session record at the call, which the caller checked the viewer
   * against): see sameRegistration.
   */
  async request(session_id: string, req: ProxyRequest, timeoutMs: number): Promise<ProxyResponse> {
    const registration = this.store.getSession(session_id)
    try {
      return await this.requestOnce(session_id, req, timeoutMs)
    } catch (err) {
      const reason = err instanceof Error ? err.message : ''
      const linkDropped = reason === 'bridge not connected' || reason === 'bridge closed' || reason === 'bridge unreachable'
      // Re-dialling, or already back: a socket the bridge replaced with a new
      // one fails its requests after that one connected, and the connection
      // cleared the drop mark.
      const reconnecting = this.recentlyDropped(session_id) || this.isConnected(session_id)
      if (req.method !== 'GET' || !linkDropped || !reconnecting) throw err
      if (!(await this.waitForConnection(session_id, bridgeReconnectWaitMs()))) throw err
      if (!this.sameRegistration(session_id, registration)) throw new Error('session closed')
      return this.requestOnce(session_id, req, timeoutMs)
    }
  }

  /**
   * Whether `registration` still holds `session_id`, after a wait for its bridge.
   *
   * A wait is keyed by the id, and the id is not a secret: it is in the share
   * link. An owner whose uplink dropped could stop the share meanwhile (the
   * store frees an id registered without an owner_key at once), anyone holding
   * the link could register it again and connect a bridge, and the waiting
   * request woke to THAT socket — sent with the ended share's project directory
   * in its query, and answered to the ended share's viewer with whatever the
   * new bridge chose. The store builds a new Session record for every
   * registration (an owner's replacement of its own included) and never
   * reinstates one, and a bridge socket is authenticated against the record
   * the store holds when it connects; so the same record before and after the
   * wait means the socket now connected is that registration's bridge.
   */
  sameRegistration(session_id: string, registration: Session | undefined): boolean {
    return registration !== undefined && this.store.getSession(session_id) === registration
  }

  /**
   * Treat this session's bridge as re-dialling, as if the relay had seen its
   * link drop. For sessions restored from a previous relay process: their
   * bridges were connected to that process and are dialling this one, but the
   * drop was recorded in memory that did not survive the restart. Without it,
   * every viewer GET in the seconds before the bridge's next dial failed at
   * once with 502 "bridge not connected" instead of waiting for it. It also
   * makes that dial a re-dial, so open viewers are caught up on what opencode
   * emitted while no relay was listening. A bridge that never returns costs a
   * GET the same bounded wait as after a live drop, for the same 60 s.
   */
  expectReconnect(session_id: string): void {
    if (!this.isConnected(session_id)) this.markDropped(session_id)
  }

  /** Record a lost link. Bounded: stale entries are pruned once the map grows. */
  private markDropped(session_id: string): void {
    const now = Date.now()
    if (this.droppedAt.size >= 1024) {
      for (const [id, at] of this.droppedAt) if (now - at > BridgeClient.RECENT_DROP_MS) this.droppedAt.delete(id)
    }
    this.droppedAt.set(session_id, now)
  }

  /**
   * Is this session's bridge likely re-dialling right now? Only then is a
   * request worth holding: a bridge that never connected, or left long ago,
   * fails fast as before rather than stalling every viewer request.
   */
  private recentlyDropped(session_id: string): boolean {
    const at = this.droppedAt.get(session_id)
    return at !== undefined && Date.now() - at <= BridgeClient.RECENT_DROP_MS
  }

  /** Resolves true once the session has an open bridge socket, false after `ms`. */
  waitForConnection(session_id: string, ms: number): Promise<boolean> {
    if (this.isConnected(session_id)) return Promise.resolve(true)
    return new Promise((resolve) => {
      let waiters = this.connectWaiters.get(session_id)
      if (!waiters) {
        waiters = new Set()
        this.connectWaiters.set(session_id, waiters)
      }
      const set = waiters
      const finish = (connected: boolean) => {
        clearTimeout(timer)
        set.delete(wake)
        if (set.size === 0 && this.connectWaiters.get(session_id) === set) this.connectWaiters.delete(session_id)
        resolve(connected)
      }
      const wake = () => finish(this.isConnected(session_id))
      const timer = setTimeout(() => finish(false), ms)
      set.add(wake)
    })
  }

  private requestOnce(session_id: string, req: ProxyRequest, timeoutMs: number): Promise<ProxyResponse> {
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
        // Logged (budgeted) because a timeout on a CONNECTED bridge is the
        // congested-uplink signature, and nothing else would record it. The
        // path only, never the query or body.
        this.logLifecycle(
          `proxy timeout session=${JSON.stringify(session_id)} ${req.method} ${JSON.stringify(req.path.split('?')[0])} after ${timeoutMs}ms`,
        )
        reject(new Error('proxy timeout'))
      }, timeoutMs)
      this.pending.set(request_id, { session_id, ws, resolve, reject, timer })
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
    // Idempotent: a stream unsubscribes from more than one 'close' event, and a
    // repeat call must not delete a set that has since replaced this one.
    return () => {
      set.delete(listener)
      if (set.size === 0 && this.eventListeners.get(session_id) === set) this.eventListeners.delete(session_id)
    }
  }

  /**
   * Be told whenever a session's bridge comes back after losing its link —
   * never for its first connection. Returns an unsubscribe function.
   *
   * Everything opencode emitted while the link was down is gone: the bridge
   * keeps reading its /event stream through an outage and has nowhere to send
   * what it reads, and whatever sat in the dead socket's buffer went with it.
   * The event stream itself has no way to say so, which is why the viewer
   * side needs this signal (see the proxy adapter's resync).
   */
  onReconnect(listener: (session_id: string) => void): () => void {
    this.reconnectListeners.add(listener)
    return () => {
      this.reconnectListeners.delete(listener)
    }
  }

  /**
   * Runs inside the WebSocket server's 'connection' handler, where an
   * exception would escape as an uncaught error and end the process — so a
   * listener that throws is logged, never rethrown.
   */
  private notifyReconnect(session_id: string): void {
    for (const listener of [...this.reconnectListeners]) {
      try {
        listener(session_id)
      } catch (err) {
        console.warn(`[bridge] reconnect listener failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /**
   * Drop one session's bridge connection (session stopped): close the socket
   * and fail its pending proxy requests.
   *
   * Also when no bridge is connected: a share stopped while its bridge was
   * re-dialling has no socket here, but it has requests waiting for that
   * re-dial, and the mark that one is under way. Both used to stay behind for
   * the id's next registration — the requests woke to its bridge (see
   * sameRegistration) or waited out their time for nothing, and that
   * registration's first connection counted as a re-dial. Woken now, the
   * waiters find no bridge and fail at once.
   */
  disconnect(session_id: string): void {
    this.droppedAt.delete(session_id)
    const ws = this.clients.get(session_id)
    if (ws) {
      this.clients.delete(session_id)
      this.failPending(session_id, 'session closed')
      ws.close(4001, 'session closed')
    }
    // After the socket is gone, so each waiter sees no connection.
    const waiters = this.connectWaiters.get(session_id)
    if (waiters) for (const wake of [...waiters]) wake()
  }

  /** Close all bridge connections and fail every pending proxy request. */
  close() {
    clearInterval(this.keepAlive)
    for (const waiters of this.connectWaiters.values()) for (const wake of [...waiters]) wake()
    this.connectWaiters.clear()
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error('bridge closed'))
    }
    this.pending.clear()
    for (const ws of this.clients.values()) ws.terminate()
    this.clients.clear()
    this.wss.close()
  }

  /**
   * A proxy response whose body the bridge gzipped. The body is inflated with
   * a hard output limit of GZIP_MAX_RATIO times its compressed size, so a
   * decompression bomb costs at most what that ratio allows and then fails
   * only its own request (a 502 to that viewer). Malformed frames are dropped
   * like malformed JSON is — and, like it, never reach the pending table.
   */
  private async onCompressedResponse(session_id: string, raw: WebSocket.RawData): Promise<void> {
    if (typeof session_id !== 'string' || session_id === '') return
    if (!Buffer.isBuffer(raw) || raw.length < 4) return
    const headerLength = raw.readUInt32BE(0)
    if (headerLength > GZIP_MAX_HEADER_BYTES || 4 + headerLength > raw.length) return
    let header: {
      type?: unknown
      request_id?: unknown
      status?: unknown
      contentType?: unknown
      nextCursor?: unknown
      encoding?: unknown
    }
    try {
      header = JSON.parse(raw.subarray(4, 4 + headerLength).toString('utf8'))
    } catch {
      return
    }
    if (header?.type !== 'proxy_response' || header.encoding !== 'gzip' || typeof header.request_id !== 'string') return
    const pending = this.pending.get(header.request_id)
    if (!pending) return
    if (pending.session_id !== session_id) {
      this.warnCrossSession(session_id, pending.session_id)
      return
    }
    // Claimed now, so the timeout cannot fire into a response being inflated.
    this.pending.delete(header.request_id)
    clearTimeout(pending.timer)
    const compressed = raw.subarray(4 + headerLength)
    const maxOutputLength = Math.min(compressed.length * GZIP_MAX_RATIO, GZIP_MAX_OUTPUT_BYTES)
    try {
      const body = await new Promise<Buffer>((resolve, reject) =>
        gunzip(compressed, { maxOutputLength }, (err, out) => (err ? reject(err) : resolve(out))),
      )
      pending.resolve({
        status: typeof header.status === 'number' ? header.status : 502,
        contentType: typeof header.contentType === 'string' ? header.contentType : undefined,
        nextCursor: nextCursorOf(header.nextCursor),
        body: body.toString('utf8'),
      })
    } catch (err) {
      this.logLifecycle(
        `undecodable compressed response from session=${JSON.stringify(session_id)} ` +
          `(${compressed.length} bytes): ${err instanceof Error ? err.message : String(err)}`,
      )
      pending.reject(new Error('bad compressed response'))
    }
  }

  private onMessage(session_id: string, raw: WebSocket.RawData) {
    // Everything below is routed by the socket's session id. An empty (or
    // otherwise non-string) id is not a session: it would alias the '' bucket
    // of the listener map, so two such sockets would fan their events into
    // each other's viewers. verifyBridgeToken already rejects it at the
    // upgrade, so this only ever fires on a bug — drop the message rather
    // than route it anywhere.
    if (typeof session_id !== 'string' || session_id === '') return
    let msg: { type?: string; request_id?: string; data?: string } & Partial<ProxyResponse>
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (msg.type === 'proxy_response' && typeof msg.request_id === 'string') {
      const pending = this.pending.get(msg.request_id)
      if (!pending) return
      // The one lookup in this hub keyed by something other than the session:
      // a response arriving on session A's socket is matched against a table
      // shared with every other session, so this is where two sessions' data
      // can meet. request_id is a UUIDv4, so guessing a live one is not
      // realistic and the check is defense-in-depth — but without it a single
      // leaked or mis-copied id (a shared log, a buggy bridge replaying an old
      // id) lets one share answer, and thereby poison, another share's viewer
      // traffic. Drop the message and leave the entry pending so its real
      // bridge can still answer it (or its timeout can fire).
      if (pending.session_id !== session_id) {
        this.warnCrossSession(session_id, pending.session_id)
        return
      }
      this.pending.delete(msg.request_id)
      clearTimeout(pending.timer)
      pending.resolve({
        status: typeof msg.status === 'number' ? msg.status : 502,
        contentType: typeof msg.contentType === 'string' ? msg.contentType : undefined,
        nextCursor: nextCursorOf(msg.nextCursor),
        body: typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body ?? null),
      })
      return
    }
    if (msg.type === 'event' && typeof msg.data === 'string') {
      for (const listener of this.eventListeners.get(session_id) ?? []) listener(msg.data)
    }
  }
}
