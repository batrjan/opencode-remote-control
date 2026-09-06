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
  ['GET', '/experimental/session'],
  ['GET', '/experimental/capabilities'],
  ['GET', '/experimental/workspace'],
  ['GET', '/experimental/worktree'],
  ['GET', '/api/reference'],
  ['GET', '/api/session'],
  ['GET', '/api/agent'],
  ['GET', '/api/command'],
  ['GET', '/api/skill'],
  ['GET', '/skill'],
  ['GET', '/pty'],
  ['GET', '/pty/shells'],
  // UI telemetry
  ['POST', '/log'],
  // Permission API (opencode's tool-approval surface). The viewer drives the
  // same session the bridge is bound to, so these are proxied to the bound
  // session's opencode. /permission/request is a long-poll and gets the
  // extended timeout below.
  ['GET', '/permission'],
  ['GET', '/permission/request'],
  ['GET', '/permission/saved'],
  ['GET', '/permission/:requestID'],
  ['POST', '/permission/:requestID/reply'],
  ['POST', '/permission/saved'],
  ['POST', '/permission/saved/:id'],
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
  ): Promise<void> {
    const timeout = LONG_POLL_PREFIXES.some((p) => path.startsWith(p))
      ? LONG_POLL_TIMEOUT_MS
      : config.proxyTimeoutMs
    try {
      const out = await bridge.request(session_id, { method, path, body }, timeout)
      res
        .status(out.status)
        .type(out.contentType ?? 'application/json')
        .send(out.body)
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
    params.set('directory', session.directory)
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
      let path = template.replaceAll(':id', session.id)
      if (typeof req.params.permissionID === 'string') {
        path = path.replaceAll(':permissionID', encodeURIComponent(req.params.permissionID))
      }
      void proxy(res, session.id, method, path + queryForSession(req, session), method === 'POST' ? req.body : undefined)
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
