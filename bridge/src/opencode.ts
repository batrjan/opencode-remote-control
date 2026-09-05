import { basicAuthHeader } from './config'

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

  async getSessions() {
    const res = await fetch(`${this.url}/session`, { headers: this.auth() })
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

  async getAgents() {
    const res = await fetch(`${this.url}/agent`, { headers: this.auth() })
    return res.json()
  }

  async getConfig() {
    const res = await fetch(`${this.url}/config`, { headers: this.auth() })
    return res.json()
  }

  /** SSE stream of server events; caller consumes the ReadableStream. */
  async getEvent() {
    const res = await fetch(`${this.url}/event`, { headers: this.auth() })
    return res.body
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
