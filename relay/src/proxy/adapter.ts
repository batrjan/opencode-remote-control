import express from 'express'
import type { Request, Response } from 'express'
import type { Store, Session } from '../store.js'
import type { BridgeClient } from '../ws/bridge.js'
import { config } from '../config.js'

/**
 * HTTP → WS → opencode proxy adapter, mounted at /api/opencode.
 *
 * Viewer auth: every request must carry a viewer_token (HttpOnly cookie,
 * ?token= query param, or x-viewer-token header). The session is resolved
 * from the token and the URL :id is ALWAYS replaced by it (forced binding
 * per the design spec — a viewer can only ever reach its own session).
 *
 * Allowlist (everything else 404s by not being routed):
 *   GET  /session/:id/message?limit=N
 *   POST /session/:id/prompt_async
 *   GET  /session/:id/todo
 *   GET  /session/:id/status
 *   GET  /agent
 *   GET  /config
 *   GET  /event         — SSE re-emission of opencode events pushed by the bridge
 *   GET  /global/event  — same fan-out; the v1 UI SDK subscribes at this path
 *                         (relative to the configured server URL)
 */
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
    try {
      const out = await bridge.request(session_id, { method, path, body }, config.proxyTimeoutMs)
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

  router.get('/session/:id/message', (req, res) => {
    const session = requireViewer(req, res)
    if (!session) return
    const limit = typeof req.query.limit === 'string' ? req.query.limit : undefined
    const query = limit === undefined ? '' : `?limit=${encodeURIComponent(limit)}`
    void proxy(res, session.id, 'GET', `/session/${session.id}/message${query}`)
  })

  router.post('/session/:id/prompt_async', (req, res) => {
    const session = requireViewer(req, res)
    if (!session) return
    void proxy(res, session.id, 'POST', `/session/${session.id}/prompt_async`, req.body)
  })

  router.get('/session/:id/todo', (req, res) => {
    const session = requireViewer(req, res)
    if (!session) return
    void proxy(res, session.id, 'GET', `/session/${session.id}/todo`)
  })

  router.get('/session/:id/status', (req, res) => {
    const session = requireViewer(req, res)
    if (!session) return
    void proxy(res, session.id, 'GET', `/session/${session.id}/status`)
  })

  router.get('/agent', (req, res) => {
    const session = requireViewer(req, res)
    if (!session) return
    void proxy(res, session.id, 'GET', '/agent')
  })

  router.get('/config', (req, res) => {
    const session = requireViewer(req, res)
    if (!session) return
    void proxy(res, session.id, 'GET', '/config')
  })

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

/** viewer_token from the HttpOnly cookie, ?token=, or x-viewer-token. */
function extractViewerToken(req: Request): string | undefined {
  const header = req.get('x-viewer-token')
  if (header) return header
  const query = req.query.token
  if (typeof query === 'string' && query.length > 0) return query
  const cookie = req.get('cookie')
  if (cookie) {
    for (const pair of cookie.split(';')) {
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      if (pair.slice(0, eq).trim() === 'viewer_token') {
        return decodeURIComponent(pair.slice(eq + 1).trim())
      }
    }
  }
  return undefined
}
