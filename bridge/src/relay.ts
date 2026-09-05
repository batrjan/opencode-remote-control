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
}
