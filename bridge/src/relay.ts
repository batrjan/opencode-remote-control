import WebSocket from 'ws'
import type { OpencodeClient } from './opencode.js'

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

export class RelayClient {
  constructor(
    public url: string,
    public apiKey: string,
  ) {}

  private headers() {
    return { 'Content-Type': 'application/json', 'x-api-key': this.apiKey }
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

  /** End a session on the relay. Returns the relay's HTTP status. */
  async deleteSession(sessionId: string): Promise<number> {
    const res = await fetch(`${this.url}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    return res.status
  }

  /** Session status probe for `bridge status`. Returns the relay's HTTP status. */
  async getSession(sessionId: string): Promise<number> {
    const res = await fetch(`${this.url}/api/sessions/${encodeURIComponent(sessionId)}`, {
      headers: this.headers(),
    })
    return res.status
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
    const base = this.relayUrl.replace(/^http/, 'ws')
    const url =
      `${base}/bridge?session_id=${encodeURIComponent(session_id)}` +
      `&token=${encodeURIComponent(bridge_token)}`
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url)
      this.ws = ws
      let opened = false
      ws.on('open', () => {
        opened = true
        resolve()
      })
      ws.on('error', (err) => {
        if (!opened) reject(err)
      })
      ws.on('close', (code) => {
        if (!opened) {
          reject(new Error(`relay refused bridge connection (close code ${code})`))
          return
        }
        if (this.ws === ws) this.ws = null
      })
      ws.on('message', (raw) => {
        void this.onMessage(raw)
      })
    })
  }

  /** Subscribe to opencode's /event SSE stream and push each event to the relay. */
  async startEventForwarding(): Promise<void> {
    this.eventAbortController = new AbortController()
    const stream = await this.opencode.getEvent(this.eventAbortController.signal)
    if (!stream) throw new Error('opencode /event stream unavailable')
    void readSseStream(stream, (data) => this.send({ type: 'event', data }))
  }

  close() {
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
