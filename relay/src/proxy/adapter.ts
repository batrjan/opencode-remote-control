import express from 'express'
import type { Request, Response } from 'express'
import type { Store, Session } from '../store.js'
import type { BridgeClient } from '../ws/bridge.js'
import { config } from '../config.js'

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
  ['GET', '/project'],
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
  // Question/resource/reference APIs the UI bootstrap resolves
  ['GET', '/question'],
  ['POST', '/question'],
  ['GET', '/experimental/resource'],
  ['GET', '/experimental/capabilities'],
  ['GET', '/experimental/workspace'],
  ['GET', '/experimental/worktree'],
  ['GET', '/api/reference'],
  ['GET', '/api/agent'],
  ['GET', '/api/command'],
  ['GET', '/api/skill'],
  ['GET', '/skill'],
  ['GET', '/pty'],
  ['GET', '/pty/shells'],
  // UI telemetry
  ['POST', '/log'],
  // Permission API. SECURITY: instance-wide permission endpoints are NOT
  // exposed — GET /permission lists pending requests from ALL sessions of
  // the owner, and permission request IDs are instance-global, so a viewer
  // could approve a prompt belonging to another session. The only allowed
  // route is the session-scoped respond, which stays force-bound to the
  // viewer's own session AND is further restricted bridge-side (the bridge
  // refuses to reply to a requestID that does not belong to the bound
  // session — see bridge permission guard).
  // (No entries here on purpose; see the session-scoped
  // /session/:id/permissions/:permissionID route in ALLOWED_ROUTES.)
]

/** Paths that are long-polls upstream (opencode holds them open until an
 * event arrives). They get a longer proxy timeout than normal requests. */
const LONG_POLL_PREFIXES = ['/permission/request', '/question']
const LONG_POLL_TIMEOUT_MS = 120_000

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
      const message = err instanceof Error ? err.message : 'proxy failed'
      if (message === 'bridge not connected') {
        res.status(502).json({ error: 'bridge not connected' })
      } else if (message === 'proxy timeout') {
        res.status(504).json({ error: 'proxy timeout' })
      } else {
        res.status(502).json({ error: 'proxy failed' })
      }
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
  function queryForSession(req: Request, session: Session): string {
    const params = new URLSearchParams(queryOf(req))
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

  // GET /session — the UI's session list, collapsed to the viewer's own
  // session. Registered before '/session/:id'.
  router.get('/session', (req, res) => {
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
      } catch {
        res.status(502).json({ error: 'bridge not connected' })
      }
    })()
  })

  // GET /session/status — global status map, filtered to the viewer's
  // session only (other sessions' statuses are not the viewer's business).
  router.get('/session/status', (req, res) => {
    const session = requireViewer(req, res)
    if (!session) return
    void (async () => {
      try {
        const out = await bridge.request(
          session.id,
          { method: 'GET', path: '/session/status' },
          config.proxyTimeoutMs,
        )
        let body = out.body
        try {
          const all = JSON.parse(out.body) as Record<string, unknown>
          body = JSON.stringify({ [session.id]: all[session.id] })
        } catch {
          // upstream not JSON — pass through verbatim
        }
        res.status(out.status).type(out.contentType ?? 'application/json').send(body)
      } catch {
        res.status(502).json({ error: 'bridge not connected' })
      }
    })()
  })

  for (const [method, template] of ALLOWED_ROUTES) {
    const handler = (req: Request, res: Response) => {
      const session = requireViewer(req, res)
      if (!session) return
      // STRICT isolation: the viewer can only ever reach its OWN session.
      // The URL :id is ALWAYS replaced with the viewer's session, even for
      // reads. See the parentID sanitization below for why this does not
      // loop the UI's parent-chain walk.
      let path = template.replaceAll(':id', session.id)
      if (typeof req.params.permissionID === 'string') {
        path = path.replaceAll(':permissionID', encodeURIComponent(req.params.permissionID))
      }
      if (typeof req.params.messageID === 'string') {
        path = path.replaceAll(':messageID', encodeURIComponent(req.params.messageID))
      }
      // Sanitize session-detail reads: strip parentID so the UI never walks
      // a parent chain (which would loop under forced :id binding).
      const sanitize = template === '/session/:id' && method === 'GET'
      void proxy(res, session.id, method, path + queryForSession(req, session), method === 'POST' ? req.body : undefined, sanitize ? stripParentId : undefined)
    }
    if (method === 'GET') router.get(template, handler)
    else router.post(template, handler)
  }

  /** SSE fan-out of the session's opencode events to one viewer response. */
  function sseEvents(req: Request, res: Response, session: Session): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    const unsubscribe = bridge.subscribeEvents(session.id, (data) => {
      // The bridge forwards the instance-wide /event stream (filtered by
      // directory upstream, NOT by session). Forward only events that belong
      // to the viewer's session or carry no session at all (server heartbeats
      // / status) — otherwise viewers would watch the owner's OTHER sessions
      // live. Fail closed on unparseable payloads.
      if (!eventBelongsToSession(data, session.id)) return
      // SSE-safe: prefix every line of a (possibly multi-line) payload.
      res.write(
        data
          .split('\n')
          .map((line) => `data: ${line}`)
          .join('\n') + '\n\n',
      )
    })
    req.on('close', unsubscribe)
  }

  router.get('/event', (req, res) => {
    const session = requireViewer(req, res)
    if (!session) return
    sseEvents(req, res, session)
  })

  router.get('/global/event', (req, res) => {
    const session = requireViewer(req, res)
    if (!session) return
    sseEvents(req, res, session)
  })

  return router
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
 * Whether an opencode event payload belongs to the given session. Events
 * with no session reference (server.connected, heartbeats, global status) are
 * kept; events carrying a DIFFERENT session id are dropped. Fails closed
 * (drops) when the payload can't be understood.
 */
export function eventBelongsToSession(data: string, sessionId: string): boolean {
  let ev: unknown
  try {
    ev = JSON.parse(data)
  } catch {
    return false
  }
  if (!ev || typeof ev !== 'object') return true
  const e = ev as Record<string, unknown>
  const props = (e.properties ?? e) as Record<string, unknown>
  const candidates = [
    e.sessionID,
    e.session_id,
    props?.sessionID,
    props?.session_id,
    (props?.info as Record<string, unknown> | undefined)?.sessionID,
    (props?.info as Record<string, unknown> | undefined)?.id,
    (e.info as Record<string, unknown> | undefined)?.sessionID,
    (e.info as Record<string, unknown> | undefined)?.id,
  ]
  const mentioned = candidates.filter((c): c is string => typeof c === 'string' && c.length > 0)
  // No session mentioned anywhere → global event, safe to forward.
  if (mentioned.length === 0) return true
  return mentioned.every((id) => id === sessionId)
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
