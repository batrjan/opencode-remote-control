import { basicAuthHeader } from './config.js'
import { fetchFrom } from './errors.js'

/** How an unreachable opencode is named to the owner — see fetchFrom. */
const LOCAL_SERVER = 'local opencode server'

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
    // `start` picks its session with this, so a local opencode that is not
    // listening is where a start fails: it must not read like a relay failure.
    const res = await fetchFrom(LOCAL_SERVER, `${this.url}/session${query}`, { headers: this.auth() })
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

  /**
   * Pending permission requests (instance-wide list; callers must filter).
   * `query` ('' or '?…') picks the instance, as for listQuestions: opencode
   * holds pending permissions per directory, and without one it lists the
   * SERVER's own instance — empty whenever the session lives elsewhere.
   */
  async listPermissions(query = '') {
    const res = await fetch(`${this.url}/permission${query}`, { headers: this.auth() })
    if (!res.ok) throw new Error(`listPermissions failed: ${res.status}`)
    return res.json()
  }

  /**
   * Pending question requests (instance-wide list; callers must filter).
   * `query` ('' or '?…') picks the instance — pass the query of the request
   * being checked so the list comes from the instance that request reaches.
   */
  async listQuestions(query = '') {
    const res = await fetch(`${this.url}/question${query}`, { headers: this.auth() })
    if (!res.ok) throw new Error(`listQuestions failed: ${res.status}`)
    return res.json()
  }

  /**
   * One session's detail. `query` picks the instance, as for listPermissions.
   * Throws unless opencode answers 200 — the ownership guards read a
   * subagent's parent chain with it and must never guess.
   */
  async getSession(id: string, query = '') {
    const res = await fetch(`${this.url}/session/${encodeURIComponent(id)}${query}`, { headers: this.auth() })
    // The status rides along: the ownership guards tell a session opencode
    // says it does not have (404 — ruled out) from one it could not answer
    // for at all (anything else — unknown), and refuse them differently.
    if (!res.ok) throw Object.assign(new Error(`getSession failed: ${res.status}`), { status: res.status })
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

  /**
   * SSE stream of server events; caller consumes the ReadableStream.
   *
   * `directory` scopes the stream. opencode filters /event by the project
   * directory, defaulting to the SERVER's own instance directory — so a
   * subscription without it silently yields nothing but heartbeats whenever
   * the shared session lives somewhere else (the desktop app hosting many
   * projects, or a bridge started from another folder). The viewer then sat on
   * "thinking" forever while the answer was already complete on disk.
   */
  async getEvent(signal?: AbortSignal, directory?: string) {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : ''
    // Named like getSessions: with an explicit session id this is the first
    // call a `start` makes to opencode that is allowed to fail it.
    const res = await fetchFrom(LOCAL_SERVER, `${this.url}/event${query}`, { headers: this.auth(), signal })
    return res.body
  }

  /**
   * Generic pass-through used by the relay WS proxy: executes an arbitrary
   * allowlisted request and returns the raw body plus content-type so the
   * relay can forward them verbatim.
   *
   * Of the other response headers only X-Next-Cursor goes along. opencode
   * pages a transcript (GET /session/:id/message?limit=N) and names the older
   * page nowhere else — the body is a bare array — so without it the web UI
   * takes the newest page for the whole history and a viewer never sees past
   * it. Link carries the same cursor but also this machine's opencode URL and
   * the absolute project directory, so it stays here.
   */
  async request(method: string, path: string, body?: unknown) {
    // Long-poll endpoints (opencode holds them open until an event arrives)
    // must not be cut off by the default 30s guard. The question routes are
    // not long-polls: the pending list is answered at once and a reply or
    // reject settles a question already waiting, so a local opencode that
    // stopped answering held them for 130 s, long after the relay gave up.
    const isLongPoll = path.startsWith('/permission/request')
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
        nextCursor: res.headers.get('x-next-cursor') ?? undefined,
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
