import { basicAuthHeader } from './config.js'

/**
 * Minimal client for the local OpenCode server HTTP API.
 * All requests carry HTTP Basic auth (server default username 'opencode').
 */
export class OpencodeClient {
  constructor(
    public url: string,
    public username: string,
    public password: string,
  ) {}

  private auth() {
    return { Authorization: basicAuthHeader(this.username, this.password) }
  }

  async getSessions(directory?: string) {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : ''
    const res = await fetch(`${this.url}/session${query}`, { headers: this.auth() })
    return res.json()
  }

  async getSessionMessages(id: string, limit?: number) {
    const query = limit === undefined ? '' : `?limit=${limit}`
    const res = await fetch(`${this.url}/session/${id}/message${query}`, {
      headers: this.auth(),
    })
    return res.json()
  }

  async getTodo(id: string) {
    const res = await fetch(`${this.url}/session/${id}/todo`, { headers: this.auth() })
    return res.json()
  }

  async getStatus() {
    const res = await fetch(`${this.url}/session/status`, { headers: this.auth() })
    return res.json()
  }

  /** Pending permission requests (instance-wide list; callers must filter). */
  async listPermissions() {
    const res = await fetch(`${this.url}/permission`, { headers: this.auth() })
    if (!res.ok) throw new Error(`listPermissions failed: ${res.status}`)
    return res.json()
  }

  async getAgents() {
    const res = await fetch(`${this.url}/agent`, { headers: this.auth() })
    return res.json()
  }

  async getConfig() {
    const res = await fetch(`${this.url}/config`, { headers: this.auth() })
    return res.json()
  }

  /** SSE stream of server events; caller consumes the ReadableStream. */
  async getEvent(signal?: AbortSignal) {
    const res = await fetch(`${this.url}/event`, { headers: this.auth(), signal })
    return res.body
  }

  /**
   * Generic pass-through used by the relay WS proxy: executes an arbitrary
   * allowlisted request and returns the raw body plus content-type so the
   * relay can forward them verbatim.
   */
  async request(method: string, path: string, body?: unknown) {
    // Long-poll endpoints (opencode holds them open until an event arrives)
    // must not be cut off by the default 30s guard.
    const isLongPoll = path.startsWith('/permission/request') || path.startsWith('/question')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), isLongPoll ? 130_000 : 30_000)
    try {
      const res = await fetch(`${this.url}${path}`, {
        method,
        headers: {
          ...this.auth(),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      return {
        status: res.status,
        contentType: res.headers.get('content-type') ?? 'application/json',
        body: await res.text(),
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  async postPromptAsync(id: string, body: unknown) {
    const res = await fetch(`${this.url}/session/${id}/prompt_async`, {
      method: 'POST',
      headers: { ...this.auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.status
  }

  async deleteSession(id: string) {
    const res = await fetch(`${this.url}/session/${id}`, {
      method: 'DELETE',
      headers: this.auth(),
    })
    return res.status
  }
}
