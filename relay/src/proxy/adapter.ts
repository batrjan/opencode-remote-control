import { randomUUID } from 'node:crypto'
import express from 'express'
import type { Request, Response } from 'express'
import type { Store, Session } from '../store.js'
import type { BridgeClient } from '../ws/bridge.js'
import { bridgeReconnectWaitMs, config, promptTimeoutMs, sseHeartbeatMs, sseMaxBufferBytes, sseRetryMs } from '../config.js'

/**
 * HTTP → WS → opencode proxy adapter, mounted at the server ROOT.
 *
 * The official opencode web UI (like the real opencode web) resolves its API
 * calls against `server.url`, and absolute paths (/provider, /global/health,
 * /session/...) are fetched from the server root — a `/api/opencode` prefix
 * would be dropped by `new URL('/provider', base)`. Mounting at the root
 * makes `server.url = location.origin` work exactly as upstream intended.
 *
 * Viewer auth: every request must carry a viewer_token (HttpOnly cookie or
 * x-viewer-token header). The session is resolved from the token and any :id
 * in the URL is ALWAYS replaced by it (forced binding per the design spec —
 * a viewer can only ever reach its own session).
 *
 * The allowlist below is the interactive surface the official opencode web
 * UI actually calls. Read-only global endpoints are proxied verbatim;
 * session-scoped ones are bound to the viewer's session; session-listing
 * endpoints are collapsed to the single bound session. Mutations outside a
 * session scope (config PATCH, auth, instance dispose, TUI control, MCP
 * management, share) are NOT routed — they 404 by construction.
 */
type Method = 'GET' | 'POST'

/** [method, express-path-template]. ':id' is always replaced with the viewer's session. */
const ALLOWED_ROUTES: Array<[Method, string]> = [
  // Session detail + messages
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
  // Read-only global metadata the UI needs to boot
  ['GET', '/agent'],
  ['GET', '/command'],
  ['GET', '/config'],
  ['GET', '/config/providers'],
  ['GET', '/provider'],
  ['GET', '/provider/auth'],
  // NOTE: '/project' is NOT here — upstream lists every project the owner has
  // open, disclosing unrelated worktree paths to the viewer. It gets a
  // filtered handler below. '/project/current' is directory-pinned already.
  ['GET', '/project/current'],
  ['GET', '/path'],
  ['GET', '/vcs'],
  ['GET', '/mcp'],
  ['GET', '/lsp'],
  ['GET', '/formatter'],
  ['GET', '/experimental/tool'],
  ['GET', '/experimental/tool/ids'],
  // Read-only project browsing (viewer can already run any prompt, so
  // denying file reads adds no security; the UI needs these for the tree
  // and file previews)
  ['GET', '/file'],
  ['GET', '/file/content'],
  ['GET', '/file/status'],
  ['GET', '/find'],
  ['GET', '/find/file'],
  ['GET', '/find/symbol'],
  // Global v2 surface the UI probes at boot. NOTE: /global/event is NOT here
  // — it is the SSE stream and is fanned out locally from the bridge's
  // /event subscription (see the sseEvents handlers below).
  ['GET', '/global/health'],
  ['GET', '/global/config'],
  // Question API: the question dock's two buttons. These are opencode's only
  // question writes — there is no POST /question, which is what used to be
  // listed here, so a viewer's answer met the catch-all 404, the dock stayed up
  // and the composer stayed blocked until the owner answered locally.
  // SECURITY: both take only an instance-global request id and upstream does
  // not check which session it belongs to, so the bridge refuses ids that are
  // not pending questions of the bound session or one of its subagents. The
  // list (GET /question) is instance-wide too and gets a filtered handler
  // below, like /permission.
  ['POST', '/question/:requestID/reply'],
  ['POST', '/question/:requestID/reject'],
  // Resource/reference APIs the UI bootstrap resolves
  ['GET', '/experimental/resource'],
  ['GET', '/experimental/capabilities'],
  ['GET', '/experimental/workspace'],
  // NOTE: '/experimental/worktree' is NOT here — like '/project' it enumerates
  // the owner's other worktrees, disclosing unrelated project paths. The UI
  // boots without it.

  // '/api/reference' has no bare twin ('/reference' is not an opencode path),
  // so it is listed in its /api spelling. Everything else is listed BARE:
  // mountPaths() already registers each bare template at both '/x' and
  // '/api/x', so an explicit '/api/agent' (or '/api/command', '/api/skill')
  // only registered a second, unreachable handler behind the first.
  ['GET', '/api/reference'],
  ['GET', '/skill'],
  ['GET', '/pty'],
  ['GET', '/pty/shells'],
  // UI telemetry
  ['POST', '/log'],
  // Permission API. SECURITY: instance-wide permission endpoints are NOT
  // proxied verbatim — GET /permission upstream lists pending requests from
  // ALL sessions of the owner, and permission request IDs are instance-global,
  // so a viewer could approve a prompt belonging to another session. We expose
  // GET /permission but FILTER the response to the viewer's own session and
  // its subagents (see the handler below). The reply route stays session-scoped
  // (/session/:id/permissions/:permissionID, ':id' a subagent's own id when it
  // raised the prompt) and is additionally guarded bridge-side (refuses
  // requestIDs not owned by the bound session or one of its subagents).
]

/**
 * Routes where a SUBAGENT session of the bound one may be addressed as itself.
 *
 * Every ':id' is normally rewritten to the viewer's session, which is what
 * keeps a viewer inside its own share. For a child session that rewrite was
 * silently wrong rather than safe: the UI lists the share's 17 subagent
 * sessions via /session/:id/children and then rendered the PARENT's transcript
 * under each child's title. Children belong to the shared session, so reading
 * them is in scope — anything that is not a child still collapses to the bound
 * session.
 *
 * The session detail and the permission answer are here for the prompts a
 * subagent raises. Its permission requests carry the CHILD's id, and the web UI
 * shows them in the parent's dock only by walking the session tree, which it
 * builds from session details that name their parent. It answers them as
 * POST /session/<child>/permissions/<id>. Collapsed to the parent, the detail
 * hid the child from that tree, and the bridge refused the answer.
 */
const SUBAGENT_ROUTES = new Set([
  '/session/:id',
  '/session/:id/message',
  '/session/:id/message/:messageID',
  '/session/:id/todo',
  '/session/:id/diff',
  '/session/:id/permissions/:permissionID',
])

/** Max ancestor hops walked when deciding if a session descends from the
 * bound one — subagent nesting is shallow; this only bounds a pathological
 * chain. */
const MAX_ANCESTRY_DEPTH = 8

/** A real opencode session id — the only shape allowed to reach an upstream path. */
const SESSION_ID_RE = /^ses_[A-Za-z0-9_]+$/

/** Paths that are long-polls upstream (opencode holds them open until an
 * event arrives). They get a longer proxy timeout than normal requests. */
const LONG_POLL_PREFIXES = ['/permission/request', '/question']
const LONG_POLL_TIMEOUT_MS = 120_000

/** The prompt route whose lost answers are checked with opencode — see proxyPrompt. */
const PROMPT_ROUTE = '/session/:id/prompt_async'

/**
 * A message id as the web UI mints it for a prompt (Identifier.ascending:
 * `msg_` + hex time + base62). Only this shape is ever put into the checking
 * GET's path; anything else is not looked up.
 */
const MESSAGE_ID_RE = /^msg_[A-Za-z0-9]{1,64}$/

/**
 * Failures that can happen AFTER a prompt was sent to the bridge — so it may
 * well have reached opencode. 'bridge not connected' is not one: that prompt
 * never left the relay.
 */
const LOST_ANSWER_ERRORS = new Set(['proxy timeout', 'bridge closed', 'bridge unreachable'])

/**
 * Body cap for proxied POSTs. A viewer's prompt legitimately carries pasted
 * code, a stack trace or a whole file, which express's 100 KB default turned
 * into a 413 mid-conversation. Only viewer-authenticated traffic gets this
 * headroom — the parser is mounted behind the viewer check, on this router's
 * own POST paths only (see below), so an anonymous request can never make the
 * relay buffer 25 MB. Kept local: it is a property of the proxy surface, not
 * a relay-wide tunable.
 */
const PROXY_BODY_LIMIT = '25mb'

/**
 * Max concurrent SSE streams one session may hold open. Each stream costs a
 * bridge subscription plus a heartbeat timer and lives until the client hangs
 * up, so an authenticated viewer looping fetch('/event') could pin relay
 * memory and CPU for everyone. A real viewer opens two per tab (/event and
 * /global/event), so 64 is generous for a shared session and still bounded.
 */
const MAX_STREAMS_PER_SESSION = 64

/**
 * Cap on the ancestry cache (see ancestryOk). Sessions are never removed from
 * it when their share is deleted, so without a bound it grows for the life of
 * the process. The event filter reads its subagents from the same cache.
 */
const ANCESTRY_CACHE_MAX = 10_000

/**
 * How many of the latest messages a bridge re-dial replays to open viewer
 * streams (see resyncViewers). The web UI's own first page: the replay then
 * costs the owner's slow uplink what one viewer reload does, which was the only
 * way to recover before — and an outage of a few seconds to a keep-alive kill
 * (~40 s) does not produce more messages than that.
 */
const RESYNC_MESSAGE_LIMIT = 20

/**
 * How long a replay waits for one viewer to take its backlog before giving up
 * on that viewer. A viewer that is reading drains within seconds; one that is
 * not is left to the stuck-viewer cap, exactly as without a replay.
 */
const RESYNC_DRAIN_TIMEOUT_MS = 30_000

/** What a bridge re-dial needs from one open viewer stream. */
interface ViewerStream {
  /** Re-send opencode's handshake frame; ends the stream instead if the viewer was revoked. */
  handshake(): void
  /** Write each event (bare opencode JSON, already filtered to the session), keeping the viewer's backlog under its cap. */
  replay(events: string[]): Promise<void>
}

export function proxyAdapter(store: Store, bridge: BridgeClient) {
  const router = express.Router()

  /** Resolve the viewer's session or answer 401. Returns undefined if handled. */
  function requireViewer(req: Request, res: Response): Session | undefined {
    const token = extractViewerToken(req)
    const session = token ? store.getSessionByViewerToken(token) : undefined
    if (!session) {
      res.status(401).json({ error: 'invalid viewer token' })
      return undefined
    }
    return session
  }

  /**
   * Answer a failed bridge request with what actually failed. Every route uses
   * this: a few used to say "bridge not connected" for any error, so a bridge
   * that was connected but slow — the congested-uplink case — was reported as
   * down while the relay's own log showed it up.
   */
  function sendProxyError(res: Response, err: unknown): void {
    const message = err instanceof Error ? err.message : ''
    if (message === 'bridge not connected') res.status(502).json({ error: 'bridge not connected' })
    else if (message === 'proxy timeout') res.status(504).json({ error: 'proxy timeout' })
    else res.status(502).json({ error: 'proxy failed' })
  }

  /** Forward one request through the session's bridge; never throws. */
  async function proxy(
    res: Response,
    session_id: string,
    method: string,
    path: string,
    body?: unknown,
    transform?: (raw: string, contentType?: string) => string,
  ): Promise<void> {
    const timeout = LONG_POLL_PREFIXES.some((p) => path.startsWith(p))
      ? LONG_POLL_TIMEOUT_MS
      : config.proxyTimeoutMs
    try {
      const out = await bridge.request(session_id, { method, path, body }, timeout)
      const payload = transform ? transform(out.body, out.contentType) : out.body
      res
        .status(out.status)
        .type(out.contentType ?? 'application/json')
        .send(payload)
    } catch (err) {
      sendProxyError(res, err)
    }
  }

  /**
   * POST /session/:id/prompt_async, answered by what opencode actually did.
   *
   * opencode takes a prompt, starts the turn and answers 204 within tens of
   * milliseconds, so a prompt whose wait fails after it was sent has almost
   * always landed: its 204 queued on the owner's slow uplink until the relay's
   * timer ran out, or died in the socket of a link that dropped. The relay
   * answered those with 504 / 502 anyway, and the web UI takes any error as
   * "not sent" — it removes the message, puts the text back in the input and
   * toasts — so the viewer pressed send again and opencode ran the same turn a
   * second time (a resend carries a new message id).
   *
   * The prompt is never sent again, not even under the same id: opencode then
   * appends a second copy of the text to the message. Instead the relay asks
   * whether the message the UI named in `messageID` exists and, if it does,
   * answers the 204 opencode gave. Everything else — no usable id, a prompt
   * that never left the relay, no such message, or no way to ask — gets the
   * original error, as before.
   */
  async function proxyPrompt(res: Response, session: Session, path: string, query: string, body: unknown): Promise<void> {
    try {
      const out = await bridge.request(session.id, { method: 'POST', path: path + query, body }, promptTimeoutMs())
      res
        .status(out.status)
        .type(out.contentType ?? 'application/json')
        .send(out.body)
    } catch (err) {
      const messageID = (body as { messageID?: unknown } | null | undefined)?.messageID
      const lostAnswer = err instanceof Error && LOST_ANSWER_ERRORS.has(err.message)
      if (lostAnswer && typeof messageID === 'string' && MESSAGE_ID_RE.test(messageID)) {
        if (await promptLanded(session, messageID, query)) {
          res.status(204).end()
          return
        }
      }
      sendProxyError(res, err)
    }
  }

  /**
   * Whether opencode holds the prompt message `messageID` in the viewer's
   * session. A dropped link is waited out first (the bridge re-dials within
   * about a second), and the GET itself survives one more re-dial. Anything
   * short of a 200 naming this very message is "no".
   */
  async function promptLanded(session: Session, messageID: string, query: string): Promise<boolean> {
    if (!(await bridge.waitForConnection(session.id, bridgeReconnectWaitMs()))) return false
    try {
      const out = await bridge.request(
        session.id,
        {
          method: 'GET',
          path: `/session/${encodeURIComponent(session.id)}/message/${encodeURIComponent(messageID)}${query}`,
        },
        config.proxyTimeoutMs,
      )
      if (out.status !== 200) return false
      const info = (JSON.parse(out.body) as { info?: { id?: unknown; sessionID?: unknown } } | null)?.info
      return info?.id === messageID && info?.sessionID === session.id
    } catch {
      return false
    }
  }

  /** Original query string (the router sees the mounted path only). */
  function queryOf(req: Request): string {
    const i = req.originalUrl.indexOf('?')
    return i === -1 ? '' : req.originalUrl.slice(i)
  }

  /**
   * Force the project context: every proxied request must run against the
   * session's own directory, otherwise the (global) opencode server resolves
   * the caller's home dir (or a garbage one from the UI bootstrap) as the
   * "project" and the UI bootstraps against the wrong workspace — observed
   * as corrupted `directory` params, `/api/reference` 500s, and a redirect
   * to /new-session. The viewer has exactly one session and exactly one
   * project, so we ALWAYS overwrite the directory param with the session's.
   */
  function queryForSession(query: string, session: Session): string {
    const params = new URLSearchParams(query)
    // Overwrite every spelling of the directory/location param the opencode
    // server may read, so a garbage or home-dir value from the UI bootstrap
    // cannot leak the wrong workspace through.
    params.set('directory', session.directory)
    params.set('location[directory]', session.directory)
    // Strip params that take routing PRECEDENCE over directory upstream:
    // `workspace` can re-target the request to another local project (or even
    // a remote workspace with the owner's credentials), and `scope` widens
    // list endpoints. The viewer is bound to one session/directory — these
    // must never come from the client.
    params.delete('workspace')
    params.delete('scope')
    const qs = params.toString()
    return qs ? `?${qs}` : ''
  }

  // GET /project — upstream returns EVERY project the owner has open, so a
  // viewer of one shared session could read the filesystem paths of unrelated
  // work. Keep only the project the shared session actually lives in.
  router.get(['/project', '/api/project'], (req, res) => {
    const session = requireViewer(req, res)
    if (!session) return
    void (async () => {
      const query = queryForSession(queryOf(req), session)
      try {
        const out = await bridge.request(
          session.id,
          { method: 'GET', path: `/project${query}` },
          config.proxyTimeoutMs,
        )
        const filtered = filterProjects(out.body, session.directory, out.contentType)
        // A shared session does NOT always live inside one of the owner's
        // registered projects — a scratch dir, a fresh checkout or a path
        // opencode files under the catch-all "global" project all filter down
        // to nothing. Returning that empty list left the viewer authenticated
        // but homeless: the UI has no project to hang the session on, so it
        // renders "nothing here yet" at the root instead of the share.
        // Fall back to the session's OWN project, which is exactly the one
        // thing the viewer is entitled to see.
        if (isEmptyJsonArray(filtered)) {
          const current = await bridge.request(
            session.id,
            { method: 'GET', path: `/project/current${query}` },
            config.proxyTimeoutMs,
          )
          if (current.status === 200 && current.body.trim().startsWith('{')) {
            res.status(200).type('application/json').send(`[${current.body}]`)
            return
          }
        }
        res.status(out.status).type(out.contentType ?? 'application/json').send(filtered)
      } catch (err) {
        sendProxyError(res, err)
      }
    })()
  })

  // GET /session — the UI's session list, collapsed to the viewer's own
  // session. Registered before '/session/:id'.
  router.get(['/session', '/api/session'], (req, res) => {
    const session = requireViewer(req, res)
    if (!session) return
    void (async () => {
      try {
        const out = await bridge.request(
          session.id,
          { method: 'GET', path: `/session/${session.id}` },
          config.proxyTimeoutMs,
        )
        if (out.status === 404) {
          res.status(200).type('application/json').send('[]')
          return
        }
        res
          .status(out.status)
          .type(out.contentType ?? 'application/json')
          .send(`[${out.body}]`)
      } catch (err) {
        sendProxyError(res, err)
      }
    })()
  })

  // GET /permission — pending permission requests, FILTERED to the viewer's
  // own session and its subagents (see sessionsInShare). Upstream returns
  // every pending request on the instance (all of the owner's sessions); a
  // viewer must only ever see (and thus be able to reason about) its own. The
  // list endpoint is read-only.
  // It carries the session's directory like every other route: opencode holds
  // pending permissions per directory instance, and a bare /permission lists
  // the server's own one — empty whenever the share lives elsewhere (the
  // desktop app hosting several projects), so a pending prompt vanished from
  // the viewer on reload.
  router.get(['/permission', '/api/permission'], (req, res) => {
    const session = requireViewer(req, res)
    if (!session) return
    void (async () => {
      try {
        const out = await bridge.request(
          session.id,
          { method: 'GET', path: `/permission${queryForSession(queryOf(req), session)}` },
          config.proxyTimeoutMs,
        )
        let body = out.body
        let all: unknown
        try {
          all = JSON.parse(out.body)
        } catch {
          // upstream not JSON — pass through verbatim
        }
        if (Array.isArray(all)) {
          const pending = all as Array<Record<string, unknown> | null>
          const inShare = await sessionsInShare(session, pending.map((p) => p?.sessionID))
          body = JSON.stringify(pending.filter((p) => inShare.has(p?.sessionID as string)))
        }
        res.status(out.status).type(out.contentType ?? 'application/json').send(body)
      } catch (err) {
        sendProxyError(res, err)
      }
    })()
  })

  // GET /question — pending agent questions, FILTERED to the viewer's own
  // session and its subagents. Upstream lists every pending question on the
  // instance, so the raw list showed a viewer the question text of the owner's
  // OTHER sessions in the same project. The UI only reads it at bootstrap to
  // restore the question dock. Like /permission it keeps the directory query:
  // questions are held by the instance of the directory, the same one the
  // dock's reply is sent to.
  router.get(['/question', '/api/question'], (req, res) => {
    const session = requireViewer(req, res)
    if (!session) return
    void (async () => {
      try {
        const out = await bridge.request(
          session.id,
          { method: 'GET', path: `/question${queryForSession(queryOf(req), session)}` },
          config.proxyTimeoutMs,
        )
        let body = out.body
        let all: unknown
        try {
          all = JSON.parse(out.body)
        } catch {
          // upstream not JSON — pass through verbatim
        }
        if (Array.isArray(all)) {
          const pending = all as Array<Record<string, unknown> | null>
          const inShare = await sessionsInShare(session, pending.map((q) => q?.sessionID))
          body = JSON.stringify(pending.filter((q) => inShare.has(q?.sessionID as string)))
        }
        res.status(out.status).type(out.contentType ?? 'application/json').send(body)
      } catch (err) {
        sendProxyError(res, err)
      }
    })()
  })

  // GET /session/status — global status map, filtered to the viewer's
  // session and its subagents (other sessions' statuses are not the viewer's
  // business; a subagent's is what its parent is waiting on).
  // Statuses are per directory instance too: without the session's directory
  // upstream answers {} for a share outside the server's own folder, and a
  // busy session looked idle to the viewer.
  router.get(['/session/status', '/api/session/status'], (req, res) => {
    const session = requireViewer(req, res)
    if (!session) return
    void (async () => {
      try {
        const out = await bridge.request(
          session.id,
          { method: 'GET', path: `/session/status${queryForSession(queryOf(req), session)}` },
          config.proxyTimeoutMs,
        )
        let body = out.body
        let all: unknown
        try {
          all = JSON.parse(out.body)
        } catch {
          // upstream not JSON — pass through verbatim
        }
        if (all && typeof all === 'object' && !Array.isArray(all)) {
          const statuses = Object.entries(all)
          const inShare = await sessionsInShare(session, statuses.map(([id]) => id))
          body = JSON.stringify(Object.fromEntries(statuses.filter(([id]) => inShare.has(id))))
        }
        res.status(out.status).type(out.contentType ?? 'application/json').send(body)
      } catch (err) {
        sendProxyError(res, err)
      }
    })()
  })

  // A session's parent never changes once created, so a positive ancestry
  // result is cached forever safely (keyed bound->descendant). Negatives are
  // NOT cached: a subagent may spawn after the first miss, and re-checking is
  // cheap. This is what makes a freshly-spawned child and a nested grandchild
  // read correctly instead of showing the parent transcript under their title.
  // Keyed per share, so what one bridge reports about its sessions can never
  // widen what another share's viewers are shown.
  const ancestryOk = new Set<string>()

  /**
   * Remember a verified ancestry, evicting the oldest entry when full (a Set
   * iterates in insertion order, so the first key is the oldest). Losing a
   * positive is harmless for requests: the next one simply walks the parent
   * chain again and re-caches it. The cache is an optimisation, never the
   * authority on what a viewer may read. A key seen again moves to the newest
   * end, so a subagent that keeps working is not the one evicted.
   */
  function rememberAncestry(key: string): void {
    if (ancestryOk.delete(key)) {
      ancestryOk.add(key)
      return
    }
    while (ancestryOk.size >= ANCESTRY_CACHE_MAX) {
      const oldest = ancestryOk.values().next().value
      if (oldest === undefined) break
      ancestryOk.delete(oldest)
    }
    ancestryOk.add(key)
  }

  /**
   * The subagents of one share known so far, for the live event filter. It
   * cannot ask upstream (it must decide each event in order, at once), so it
   * learns a subagent from the child's own session.created / session.updated on
   * the share's event stream, and from every chain a request has walked.
   */
  function subagentsOf(bound: string): SubagentIndex {
    return {
      has: (id) => ancestryOk.has(`${bound}\u0000${id}`),
      add: (id) => rememberAncestry(`${bound}\u0000${id}`),
    }
  }

  /**
   * Whether `requested` DESCENDS from the viewer's session (a subagent, or a
   * nested subagent). Resolved by walking the requested session's parent chain
   * up to the bound session — never a list membership, so timing and nesting
   * cannot make a real descendant look foreign, and a foreign session can never
   * look like a descendant. Anything that cannot be verified is not one.
   */
  async function descendsFromShare(session: Session, requested: string): Promise<boolean> {
    // Only a well-formed session id may ever flow into an upstream path. This
    // is the value the caller controls, so anything that is not exactly a
    // session id (encoded slashes, query smuggling, traversal) is refused
    // instead of being interpolated raw.
    if (requested === session.id || !SESSION_ID_RE.test(requested)) return false
    const subagents = subagentsOf(session.id)
    if (subagents.has(requested)) return true
    const chain: string[] = []
    let current = requested
    for (let hop = 0; hop < MAX_ANCESTRY_DEPTH; hop++) {
      let parentID: string | undefined
      if (!SESSION_ID_RE.test(current) || chain.includes(current)) return false
      chain.push(current)
      try {
        const out = await bridge.request(
          session.id,
          // In the session's directory, like every other proxied request.
          { method: 'GET', path: `/session/${encodeURIComponent(current)}${queryForSession('', session)}` },
          config.proxyTimeoutMs,
        )
        if (out.status !== 200) return false
        const detail = JSON.parse(out.body) as { id?: unknown; parentID?: unknown }
        // A session whose own id does not echo back is not a real session.
        if (detail?.id !== current) return false
        parentID = typeof detail?.parentID === 'string' ? detail.parentID : undefined
      } catch {
        return false // cannot verify -> strict binding
      }
      if (parentID === undefined) return false // reached a root that is not ours
      // Every session on a chain that reaches the share is a descendant.
      if (parentID === session.id || subagents.has(parentID)) {
        for (const id of chain) subagents.add(id)
        return true
      }
      current = parentID
    }
    return false // chain too deep -> refuse rather than guess
  }

  /**
   * Which session id this request may actually address: the bound one, unless
   * the caller asked for one of its subagents on a route that allows it (see
   * SUBAGENT_ROUTES).
   */
  async function readableSessionId(session: Session, requested: string, template: string): Promise<string> {
    if (!SUBAGENT_ROUTES.has(template)) return session.id
    return (await descendsFromShare(session, requested)) ? requested : session.id
  }

  /**
   * The ids among `ids` that are the viewer's session or one of its subagents.
   *
   * The pending-request lists and the status map keep a subagent's entries: a
   * task-tool subagent runs in a child session, the permission or question it
   * needs carries the CHILD's id, and while it is pending the parent waits on
   * it. Kept to the bound id alone, a reload showed the parent spinning and no
   * prompt. Other sessions of the owner still never appear.
   */
  async function sessionsInShare(session: Session, ids: unknown[]): Promise<Set<string>> {
    const candidates = new Set(ids.filter((id): id is string => typeof id === 'string'))
    const inShare = new Set<string>()
    await Promise.all(
      [...candidates].map(async (id) => {
        if (id === session.id || (await descendsFromShare(session, id))) inShare.add(id)
      }),
    )
    return inShare
  }

  /**
   * Mount paths for one route template: the bare path and its `/api`-prefixed
   * twin.
   *
   * The opencode web UI speaks BOTH dialects against the same server — its
   * bootstrap asks `/api/session?limit=…` while the session view uses
   * `/session/…`, and upstream opencode serves each. The relay only ever
   * mounted the bare half, so a viewer joining a session whose project the
   * browser had not cached got 404 on `/api/session`, concluded there were no
   * sessions, and landed on an empty "create a session" screen instead of the
   * share.
   *
   * The handler and the upstream path are unchanged — the upstream path is
   * built from `template`, never from the request — so the `/api` twin
   * inherits exactly the same forced session binding and isolation.
   */
  function mountPaths(template: string): string[] {
    return template.startsWith('/api/') ? [template] : [template, `/api${template}`]
  }

  /**
   * Parse JSON bodies ONLY on this router's own POST paths, and only once the
   * caller has proven it holds a viewer token. Order is the point: the 401 is
   * answered before a single byte of the body is buffered, so the generous
   * PROXY_BODY_LIMIT is reachable by authenticated viewers only. (The app has
   * no global parser — see server.ts.)
   */
  const parseProxyBody = express.json({ limit: PROXY_BODY_LIMIT })
  const postPaths = ALLOWED_ROUTES.filter(([m]) => m === 'POST').flatMap(([, t]) => mountPaths(t))
  router.post(postPaths, (req, res, next) => {
    if (!requireViewer(req, res)) return
    parseProxyBody(req, res, next)
  })

  for (const [method, template] of ALLOWED_ROUTES) {
    const handler = (req: Request, res: Response) => {
      const session = requireViewer(req, res)
      if (!session) return
      void (async () => {
        // STRICT isolation: the viewer can only ever reach its OWN session.
        // The URL :id is ALWAYS replaced with the viewer's session, even for
        // reads — except a subagent session of that very session on the
        // routes that allow one (see SUBAGENT_ROUTES). See the parentID
        // sanitization below for why this does not loop the parent-chain walk.
        const target =
          typeof req.params.id === 'string' ? await readableSessionId(session, req.params.id, template) : session.id
        let path = template.replaceAll(':id', target)
        if (typeof req.params.permissionID === 'string') {
          path = path.replaceAll(':permissionID', encodeURIComponent(req.params.permissionID))
        }
        if (typeof req.params.messageID === 'string') {
          path = path.replaceAll(':messageID', encodeURIComponent(req.params.messageID))
        }
        if (typeof req.params.requestID === 'string') {
          path = path.replaceAll(':requestID', encodeURIComponent(req.params.requestID))
        }
        // Sanitize the bound session's detail: strip parentID so the UI never
        // walks a parent chain (which would loop under forced :id binding). A
        // subagent keeps its parentID — that link is how the UI puts it in the
        // share's session tree, and the chain ends at the stripped bound session.
        const sanitize = template === '/session/:id' && method === 'GET' && target === session.id
        if (method === 'POST' && template === PROMPT_ROUTE) {
          await proxyPrompt(res, session, path, queryForSession(queryOf(req), session), req.body)
          return
        }
        await proxy(
          res,
          session.id,
          method,
          path + queryForSession(queryOf(req), session),
          method === 'POST' ? req.body : undefined,
          sanitize ? stripParentId : undefined,
        )
      })()
    }
    if (method === 'GET') router.get(mountPaths(template), handler)
    else router.post(mountPaths(template), handler)
  }

  /**
   * SSE fan-out of the session's opencode events to one viewer response.
   *
   * `global` selects the envelope: opencode's `/event` emits the bare event,
   * while `/global/event` wraps it as `{ directory, project, payload }`. The
   * web UI subscribes to the global stream and reads `e.payload.properties` —
   * forwarding the bare event there left `payload` undefined, threw inside the
   * UI's event reducer and killed the viewer's live stream on the first event.
   */
  function sseEvents(req: Request, res: Response, session: Session, global: boolean): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    // Open exactly like opencode's own /event stream: a `server.connected`
    // frame, never an SSE comment. The web UI's fetch-based reader does not
    // skip comment lines — a leading `: connected` was parsed as an event,
    // threw on its missing `properties` and killed the viewer's stream on
    // connect, so nothing updated live until a page reload. The real
    // `server.connected` is emitted by opencode when the BRIDGE connects,
    // long before any viewer, so each viewer needs its own.
    res.flushHeaders()
    const envelope = (payload: string) =>
      global ? `{"directory":${JSON.stringify(session.directory)},"payload":${payload}}` : payload
    // opencode omits the directory on its own handshake frame; match it. The
    // web UI only takes a frame without one as the global `server.connected`.
    const handshakeFrame = () =>
      `data: ${global ? `{"payload":${JSON.stringify(serverConnectedEvent())}}` : JSON.stringify(serverConnectedEvent())}\n\n`
    // SSE-safe: prefix every line of a (possibly multi-line) payload.
    const eventFrame = (data: string) =>
      envelope(data)
        .split('\n')
        .map((line) => `data: ${line}`)
        .join('\n') + '\n\n'
    // The `retry:` field rides ALONG WITH the handshake rather than in a frame
    // of its own: a data-less frame is the same shape that broke the web UI's
    // reader before (it parsed a bare `: connected` comment as an event), so
    // every frame this stream emits still carries a data line.
    res.write(`retry: ${sseRetryMs()}\n` + handshakeFrame())
    // Keep-alive: opencode's own heartbeats only arrive while the bridge is
    // reachable, so on a flaky link the viewer's stream would sit silent —
    // long enough for proxies to close it and with no way to tell a quiet
    // session from a dead one. Emit our own on the same envelope.
    // The stream is also where the viewer's credentials are RE-checked. Auth
    // happens once, at open, and an SSE connection then lives for hours — so
    // every revocation the relay has (the idle TTL, the per-session LRU
    // eviction, deleting the share) used to stop the viewer's HTTP requests
    // while its live feed kept running. Worst case: ending a share and
    // re-sharing the same opencode session reuses the session id, and a viewer
    // revoked by the first share silently received the second one's events
    // without ever seeing the new code. Re-validating on the beat closes the
    // stream within one heartbeat. It also slides last_used, which is correct:
    // a viewer holding an open stream is present, not idle.
    const viewerToken = extractViewerToken(req)
    const subagents = subagentsOf(session.id)
    let unsubscribe: () => void = () => {}
    // Stop feeding the stream BEFORE ending it. The subscription used to be
    // dropped only on the request's 'close', which follows the response's
    // flush — seconds away for a slow client — and an event arriving in that
    // gap was written to an ended response. Node raises that as an 'error' on
    // the response, nothing listens, and an unhandled 'error' ends the process:
    // one revoked viewer on a slow link took down the relay and every share.
    const endStream = () => {
      clearInterval(heartbeat)
      unsubscribe()
      if (!res.writableEnded) res.end()
    }
    // A viewer that stops reading is dropped, not buffered for. Nothing here
    // used to look at whether the viewer kept up: every event it did not take
    // waited in this process, so one stuck phone grew by the full rate of the
    // owner's output and 64 stuck streams on one token ran the relay out of
    // memory — every share on it went down. Check after each write, so no
    // stream ever holds more than the cap. Destroy rather than endStream():
    // end() only queues the closing chunk BEHIND the backlog, so a peer that is
    // not reading keeps every queued byte, and its stream slot, for as long as
    // its TCP connection lives. Destroying frees both at once, and the viewer
    // sees its stream fail and reconnects.
    const maxBuffer = sseMaxBufferBytes()
    const send = (frame: string) => {
      res.write(frame)
      if (res.writableLength <= maxBuffer) return
      clearInterval(heartbeat)
      unsubscribe()
      res.destroy()
    }
    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return
      if (!viewerToken || !store.verifyViewer(session.id, viewerToken)) {
        endStream()
        return
      }
      send(`data: ${envelope(JSON.stringify(heartbeatEvent()))}\n\n`)
    }, sseHeartbeatMs())
    heartbeat.unref?.()
    res.on('close', () => clearInterval(heartbeat))

    const unsubscribeEvents = bridge.subscribeEvents(session.id, (data) => {
      // Belt and braces for the ordering above: whatever path ended the
      // response, never write to it afterwards.
      if (res.writableEnded || res.destroyed) return
      // The bridge forwards the instance-wide /event stream (filtered by
      // directory upstream, NOT by session). Forward only events that belong
      // to the viewer's session, one of its subagents, or carry no session at
      // all (server heartbeats / status) — otherwise viewers would watch the
      // owner's OTHER sessions live. Fail closed on unparseable payloads.
      if (!eventBelongsToSession(data, session.id, subagents)) return
      send(eventFrame(data))
    })
    const untrack = trackStream(session.id, {
      handshake: () => {
        if (res.writableEnded || res.destroyed) return
        // A replay hands over the transcript, so check the credentials first
        // rather than up to one heartbeat later.
        if (!viewerToken || !store.verifyViewer(session.id, viewerToken)) {
          endStream()
          return
        }
        send(handshakeFrame())
      },
      replay: async (events) => {
        for (const data of events) {
          if (res.writableEnded || res.destroyed) return
          send(eventFrame(data))
          // Paced by the viewer's backlog. A transcript is megabytes of tool
          // output and diffs; written in one burst it would trip the stuck-
          // viewer cap above and destroy the stream of every viewer, reading
          // or not. Half the cap leaves room for live events meanwhile.
          if (!(await backlogAtMost(res, maxBuffer / 2, RESYNC_DRAIN_TIMEOUT_MS))) return
        }
      },
    })
    unsubscribe = () => {
      unsubscribeEvents()
      untrack()
    }
    req.on('close', unsubscribe)
    res.on('close', unsubscribe)
  }

  /** Open viewer streams per session — what a bridge re-dial resyncs. */
  const viewerStreams = new Map<string, Set<ViewerStream>>()

  /** Register an open stream; returns an idempotent unregister. */
  function trackStream(session_id: string, stream: ViewerStream): () => void {
    let set = viewerStreams.get(session_id)
    if (!set) {
      set = new Set()
      viewerStreams.set(session_id, set)
    }
    const streams = set
    streams.add(stream)
    return () => {
      streams.delete(stream)
      if (streams.size === 0 && viewerStreams.get(session_id) === streams) viewerStreams.delete(session_id)
    }
  }

  /**
   * Catch open viewers up after the session's bridge re-dialled.
   *
   * Whatever opencode emitted while the link was down never reached the relay
   * (see BridgeClient.onReconnect), and the web UI cannot notice the hole: it
   * drops a part whose message it never saw, the relay's own heartbeats kept
   * its stream looking healthy, and nothing in it re-reads a transcript short
   * of a page reload. So a message begun in the outage arrived at the end with
   * no text, a session that went busy looked busy forever, and a permission
   * prompt raised meanwhile never appeared. Two things, both events the
   * unmodified UI already acts on:
   *
   *  1. The handshake again, so the UI reloads session status, permissions and
   *     questions. The stream stays OPEN: closing it instead would drop what
   *     follows into the UI's own reconnect gap.
   *  2. The latest messages, fetched through the bridge, replayed as
   *     `message.updated` + `message.part.updated` — the UI inserts or updates
   *     them like live ones.
   *
   * What it does not do: a message or part REMOVED during the outage stays on
   * screen (a snapshot cannot replay a deletion); subagent (child) sessions are
   * not resynced; and a part streaming across the re-dial can briefly lose the
   * text of the deltas that raced the snapshot, until that part's next update
   * rewrites it whole.
   */
  async function resyncViewers(session_id: string): Promise<void> {
    const session = store.getSession(session_id)
    if (!session) return
    const streams = () => [...(viewerStreams.get(session_id) ?? [])]
    for (const stream of streams()) stream.handshake()
    let events: string[]
    try {
      const out = await bridge.request(
        session_id,
        {
          method: 'GET',
          path: `/session/${encodeURIComponent(session_id)}/message${queryForSession(`?limit=${RESYNC_MESSAGE_LIMIT}`, session)}`,
        },
        config.proxyTimeoutMs,
      )
      if (out.status !== 200) return
      // Through the same filter as live events, so a replay never shows more
      // than the live stream would have. Once here rather than per stream: a
      // transcript is megabytes, and a session may have 64 streams.
      events = replayEvents(out.body, session_id).filter((data) => eventBelongsToSession(data, session_id))
    } catch {
      // Dropped again, or too slow: the next re-dial tries again.
      return
    }
    // Streams opened since the handshake get the replay too: their UI did not
    // reload the transcript either.
    await Promise.all(streams().map((stream) => stream.replay(events)))
  }

  /** Sessions with a resync under way; a re-dial landing meanwhile sets `again`. */
  const resyncing = new Map<string, { again: boolean }>()

  // One resync per session at a time: two interleaved snapshots could put an
  // older one's text over a newer one's. Re-dials during a pass collapse into
  // one more pass after it, so a flapping link cannot stack them up.
  bridge.onReconnect((session_id) => {
    if (!viewerStreams.has(session_id)) return
    const running = resyncing.get(session_id)
    if (running) {
      running.again = true
      return
    }
    const state = { again: true }
    resyncing.set(session_id, state)
    void (async () => {
      try {
        while (state.again && viewerStreams.has(session_id)) {
          state.again = false
          await resyncViewers(session_id)
        }
      } catch (err) {
        // Never an unhandled rejection: that would end the relay process.
        console.warn(`[relay] viewer resync failed: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        resyncing.delete(session_id)
      }
    })()
  })

  /** Live SSE streams per session id — the counter behind MAX_STREAMS_PER_SESSION. */
  const streamCount = new Map<string, number>()

  /**
   * Take one of the session's stream slots, open the stream, and give the
   * slot back exactly once when the request or the response closes.
   *
   * Both 'close' events are wired because neither alone covers every exit: a
   * client that hangs up mid-stream fires the request's, a socket error or a
   * stream that never got past writeHead fires the response's. The release is
   * idempotent, so firing both (the normal case) still frees exactly one slot.
   */
  function openEventStream(req: Request, res: Response, session: Session, global: boolean): void {
    const open = streamCount.get(session.id) ?? 0
    if (open >= MAX_STREAMS_PER_SESSION) {
      res.status(429).json({ error: 'too many event streams' })
      return
    }
    streamCount.set(session.id, open + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      const left = (streamCount.get(session.id) ?? 1) - 1
      if (left > 0) streamCount.set(session.id, left)
      else streamCount.delete(session.id)
    }
    res.on('close', release)
    req.on('close', release)
    // A connection can already be dead by the time this handler runs: express
    // walks its stack first (express.static stats the filesystem on every
    // request before falling through to this router), and a client that hangs
    // up in that gap has ALREADY fired 'close' on both req and res — so
    // neither listener above will ever run. The slot, the bridge subscription
    // and the heartbeat timer would then leak for the life of the process, and
    // 64 such aborts wedge the session at 429 permanently. Check explicitly,
    // and do it BEFORE sseEvents so the doomed subscription is never created.
    if (req.closed || res.closed) {
      release()
      return
    }
    try {
      sseEvents(req, res, session, global)
    } catch (err) {
      release()
      throw err
    }
  }

  router.get('/event', (req, res) => {
    const session = requireViewer(req, res)
    if (!session) return
    openEventStream(req, res, session, false)
  })

  router.get('/global/event', (req, res) => {
    const session = requireViewer(req, res)
    if (!session) return
    openEventStream(req, res, session, true)
  })

  return router
}

/**
 * Keep only the project that contains the shared session's directory.
 *
 * opencode's /project lists every project the owner has open; the viewer is
 * bound to one session, so the rest are unrelated worktree paths it has no
 * business seeing. A project matches when the session directory IS its
 * worktree or sits inside it (monorepo packages open a subdirectory).
 * Non-JSON or unexpected shapes pass through untouched.
 */
/** Whether a filtered project payload came back as an empty JSON array. */
function isEmptyJsonArray(raw: string): boolean {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) && v.length === 0
  } catch {
    return false
  }
}

export function filterProjects(raw: string, directory: string, contentType?: string): string {
  if (contentType && !contentType.includes('application/json')) return raw
  try {
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return raw
    // How deeply `base` contains `directory` (-1 = not a container). Used to
    // pick the MOST SPECIFIC project: a project at worktree '/' technically
    // contains every path, so "keep all containers" would leak it — keep only
    // the closest ancestor instead, which is the viewer's actual project.
    const containment = (base: unknown): number => {
      if (typeof base !== 'string' || !base) return -1
      const b = base.replace(/\/+$/, '') || '/'
      if (directory === b) return b.length
      const prefix = b === '/' ? '/' : b + '/'
      return directory.startsWith(prefix) ? b.length : -1
    }
    const score = (p: unknown): number => {
      const proj = p as { worktree?: unknown; sandboxes?: unknown }
      let best = containment(proj.worktree)
      if (Array.isArray(proj.sandboxes)) for (const sb of proj.sandboxes) best = Math.max(best, containment(sb))
      return best
    }
    const best = Math.max(-1, ...data.map(score))
    const kept = best < 0 ? [] : data.filter((p) => score(p) === best)
    return JSON.stringify(kept)
  } catch {
    return raw
  }
}

/**
 * Remove parentID from a session-detail JSON body. Under strict forced :id
 * binding the UI's parent-chain walk would otherwise fetch the parent, get
 * the SAME session back (because :id is always replaced), see parentID again,
 * and loop forever ("Session parent cycle"). Stripping parentID makes the
 * viewer's session look like a root session, so the chain ends immediately.
 * Non-JSON bodies pass through untouched.
 */
function stripParentId(raw: string, contentType?: string): string {
  if (contentType && !contentType.includes('application/json')) return raw
  try {
    const data = JSON.parse(raw)
    if (data && typeof data === 'object' && !Array.isArray(data) && 'parentID' in data) {
      delete (data as Record<string, unknown>).parentID
      return JSON.stringify(data)
    }
    return raw
  } catch {
    return raw
  }
}

/**
 * Turn a GET /session/:id/message answer (`[{ info, parts }]`) into the events
 * opencode would have streamed for it: `message.updated` for each message,
 * then `message.part.updated` for each of its parts. Only what provably belongs
 * to `sessionId` is kept — a message of another session, or a part that does
 * not name its own message and session — and anything unparseable yields no
 * events at all.
 */
export function replayEvents(body: string, sessionId: string): string[] {
  let items: unknown
  try {
    items = JSON.parse(body)
  } catch {
    return []
  }
  if (!Array.isArray(items)) return []
  const events: string[] = []
  for (const item of items) {
    const info = (item as { info?: Record<string, unknown> } | null)?.info
    if (!info || typeof info.id !== 'string' || info.sessionID !== sessionId) continue
    events.push(JSON.stringify({ type: 'message.updated', properties: { sessionID: sessionId, info } }))
    const parts = (item as { parts?: unknown }).parts
    if (!Array.isArray(parts)) continue
    for (const part of parts as Array<Record<string, unknown> | null>) {
      if (!part || typeof part.id !== 'string' || part.messageID !== info.id || part.sessionID !== sessionId) continue
      events.push(JSON.stringify({ type: 'message.part.updated', properties: { part } }))
    }
  }
  return events
}

/**
 * Resolves true once `res` holds at most `limit` unsent bytes; false if it
 * ends first or `ms` passes. Polled, like the bridge's own send-room wait:
 * 'drain' only fires after a write that crossed the socket's high-water mark
 * (64 KiB by default), so a limit below that would wait for it forever.
 */
async function backlogAtMost(res: Response, limit: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (res.writableLength > limit) {
    if (res.writableEnded || res.destroyed || Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !res.writableEnded && !res.destroyed
}

/** The subagents of one shared session the event filter may let through. */
export interface SubagentIndex {
  has(sessionId: string): boolean
  add(sessionId: string): void
}

/**
 * Whether an opencode event payload belongs to the given session. Events
 * with no session reference (server.connected, heartbeats, global status) are
 * kept; events carrying a DIFFERENT session id are dropped, unless that id is
 * a known subagent of the session (`subagents`). Fails closed (drops) when the
 * payload can't be understood.
 *
 * A subagent's permission and question prompts carry the CHILD's session id,
 * and the web UI shows them in the parent's dock only once the child's own
 * session.created has put it in the session tree. So a session.created or
 * session.updated whose info names the shared session, or a known subagent, as
 * its parent adds that session to `subagents` — and passes. The events come
 * from the share's own bridge, the same source every ancestry walk asks.
 */
export function eventBelongsToSession(data: string, sessionId: string, subagents?: SubagentIndex): boolean {
  let ev: unknown
  try {
    ev = JSON.parse(data)
  } catch {
    return false
  }
  if (!ev || typeof ev !== 'object') return true
  const e = ev as Record<string, unknown>
  const props = (e.properties ?? e) as Record<string, unknown>
  const mentioned = collectSessionIds(e)
  // `session.*` events identify their session by `info.id` / `id` rather than
  // by a sessionID field. Only those types may treat an `id` as a session id:
  // for `message.updated`, `info.id` is a MESSAGE id and reading it as a
  // session id dropped every message event (the viewer saw no live updates).
  if (typeof e.type === 'string' && e.type.startsWith('session.')) {
    const info = props?.info as Record<string, unknown> | undefined
    for (const candidate of [info?.id, props?.id, e.id]) {
      if (typeof candidate === 'string' && candidate.startsWith('ses')) mentioned.add(candidate)
    }
    if (subagents && (e.type === 'session.created' || e.type === 'session.updated')) {
      const id = info?.id
      const parentID = info?.parentID
      if (
        typeof id === 'string' &&
        id !== sessionId &&
        SESSION_ID_RE.test(id) &&
        typeof parentID === 'string' &&
        (parentID === sessionId || subagents.has(parentID))
      ) {
        subagents.add(id)
      }
    }
  }
  // No session mentioned anywhere → global event, safe to forward.
  if (mentioned.size === 0) return true
  for (const id of mentioned) if (id !== sessionId && !subagents?.has(id)) return false
  return true
}

/**
 * Every `sessionID` / `session_id` value anywhere in the payload. A deep scan
 * (rather than a fixed list of paths) so nested shapes are covered too —
 * `message.part.updated` carries the id under `properties.part.sessionID`,
 * which a path list missed, making other sessions' parts look "global" and
 * broadcasting them to the viewer.
 */
function collectSessionIds(root: unknown): Set<string> {
  const found = new Set<string>()
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }]
  let visited = 0
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!
    if (!node || typeof node !== 'object' || depth > EVENT_SCAN_MAX_DEPTH) continue
    if (++visited > EVENT_SCAN_MAX_NODES) break
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if ((key === 'sessionID' || key === 'session_id') && typeof value === 'string' && value.length > 0) {
        found.add(value)
      } else if (value && typeof value === 'object') {
        stack.push({ node: value, depth: depth + 1 })
      }
    }
  }
  return found
}

const EVENT_SCAN_MAX_DEPTH = 8
const EVENT_SCAN_MAX_NODES = 500

/** Relay-generated keep-alive, shaped like opencode's own heartbeat. */
function heartbeatEvent(): { id: string; type: string; properties: Record<string, never> } {
  return { id: `evt_relay_${randomUUID().replace(/-/g, '').slice(0, 20)}`, type: 'server.heartbeat', properties: {} }
}

/** The handshake frame opencode sends first on /event, per viewer. */
function serverConnectedEvent(): { id: string; type: string; properties: Record<string, never> } {
  return { id: `evt_relay_${randomUUID().replace(/-/g, '').slice(0, 20)}`, type: 'server.connected', properties: {} }
}

/** viewer_token from the HttpOnly cookie or x-viewer-token header. */
function extractViewerToken(req: Request): string | undefined {
  const header = req.get('x-viewer-token')
  if (header) return header
  const cookie = req.get('cookie')
  if (cookie) {
    for (const pair of cookie.split(';')) {
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      if (pair.slice(0, eq).trim() === 'viewer_token') {
        try {
          return decodeURIComponent(pair.slice(eq + 1).trim())
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}
