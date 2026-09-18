import type { Socket } from 'node:net'
import { gzip } from 'node:zlib'
import WebSocket from 'ws'
import type { OpencodeClient } from './opencode.js'
import {
  backoffDelay,
  eventHighWaterBytes,
  eventRetryMs,
  maxInflightProxyRequests,
  relayDeleteTimeoutMs,
  relayMaxPayloadBytes,
  relayRegisterTimeoutMs,
  wsHandshakeTimeoutMs,
  wsPingIntervalMs,
} from './config.js'
import { fetchFrom, safeForTerminal } from './errors.js'

/**
 * Client for the public relay's bridge-facing session API.
 *
 * Auth is per-session, not shared: registration (POST) is public and
 * rate-limited per IP, while DELETE/GET carry the session's OWN `bridge_token`
 * in `x-bridge-token`, so only the bridge that registered a session can end it
 * or read its owner-only fields. `apiKey` is a legacy `x-api-key` header kept
 * for relays that still gate registration behind a shared secret; the public
 * relay does not require it.
 */
export interface RelaySession {
  session_id: string
  access_code: string
  bridge_token: string
  viewer_url: string
}

/**
 * Non-secret session status returned by GET /api/sessions/:id, as far as it
 * could be believed (see parseSessionStatus). Every field is what the relay
 * said, so every field is optional or closed: 'unknown' for a status that is
 * neither of the two, undefined for a count or a timestamp that was not a
 * number, sanitized text for the two the owner is shown.
 */
export interface SessionStatus {
  session_id: string
  /** Owner-only (needs the bridge_token); absent from the public presence view. */
  directory?: string
  /** Owner-only (needs the bridge_token); absent from the public presence view. */
  title?: string
  status: 'active' | 'closed' | 'unknown'
  created_at?: number
  last_seen?: number
  viewer_count?: number
  bridge_connected: boolean
}

/** A finite number, or undefined for anything else the relay may have sent. */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The relay's answer, believed only as far as it can be checked.
 *
 * The bridge used to cast this body to SessionStatus and print the fields
 * straight to the owner's terminal and bridge.log, so the relay chose what the
 * `status` command said: a `status` of its own wording, a `viewer_count` that
 * was a string, a `title` carrying newlines to forge lines of output or an
 * escape sequence to repaint the screen (see safeForTerminal).
 *
 * `owner` is whether the request carried this share's bridge_token. Without it
 * the relay has no business sending `directory` and `title` at all — they are
 * the owner-only fields of its presence view — so they are dropped rather than
 * shown.
 */
function parseSessionStatus(value: unknown, owner: boolean): SessionStatus | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const text = (field: unknown): string | undefined =>
    typeof field === 'string' ? safeForTerminal(field) : undefined
  return {
    session_id: typeof raw.session_id === 'string' ? safeForTerminal(raw.session_id, 64) : '',
    status: raw.status === 'active' || raw.status === 'closed' ? raw.status : 'unknown',
    created_at: finiteNumber(raw.created_at),
    last_seen: finiteNumber(raw.last_seen),
    viewer_count: finiteNumber(raw.viewer_count),
    bridge_connected: raw.bridge_connected === true,
    ...(owner ? { directory: text(raw.directory), title: text(raw.title) } : {}),
  }
}

/** A relay-supplied value that goes into a URL, a header or the owner's terminal. */
function isPrintableAscii(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value)
}

/**
 * The registration's answer, believed only as far as it can be checked.
 *
 * `start` prints the viewer URL and the access code as its entire output
 * contract, the plugin shows both to the owner, and the bridge_token goes into
 * an HTTP header — so none of the three may carry a control byte, a newline or
 * a space. A relay that answers something else has not registered a share this
 * bridge can serve, and saying so beats printing whatever it sent.
 */
function parseRelaySession(value: unknown): RelaySession | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (!isPrintableAscii(raw.bridge_token, 512)) return undefined
  // Bounded loosely on purpose: the code's length and alphabet are the
  // relay's policy (config.codeAlphabet), not this bridge's to pin.
  if (!isPrintableAscii(raw.access_code, 64)) return undefined
  // A path on the relay, joined to its base URL by `start` — never an absolute
  // URL, which would send the owner somewhere else entirely.
  if (!isPrintableAscii(raw.viewer_url, 512) || !raw.viewer_url.startsWith('/') || raw.viewer_url.startsWith('//')) {
    return undefined
  }
  return {
    // Echoed back by the relay and read by nobody here — `start` shares the id
    // it asked for — so it is kept as it came, minus anything unprintable.
    session_id: typeof raw.session_id === 'string' ? safeForTerminal(raw.session_id, 128) : '',
    access_code: raw.access_code,
    bridge_token: raw.bridge_token,
    viewer_url: raw.viewer_url,
  }
}

/**
 * A relay answer that is not a success, with its status kept. The message
 * alone ("relay createSession failed: 409") left callers nothing to branch on,
 * and a 409 needs a different story than a 429 or a 502.
 *
 * `relayError` is the `error` of the relay's JSON body, when it sent one: one
 * status can mean more than one thing — a 409 is a live share holding the id
 * ('session exists') or an ended one reserving it for its owner_key ('session
 * reserved', which a relay from before that distinction never sends).
 */
export class RelayHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly relayError?: string,
  ) {
    super(message)
    this.name = 'RelayHttpError'
  }
}

/** The `error` string of a refusal's JSON body; undefined for any other body, or one that cannot be read. */
async function relayErrorOf(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown } | null
    return typeof body?.error === 'string' ? body.error : undefined
  } catch {
    return undefined
  }
}

export class RelayClient {
  constructor(
    public url: string,
    public apiKey?: string,
  ) {}

  private headers() {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    // Optional legacy key — the public relay does not require it.
    if (this.apiKey) h['x-api-key'] = this.apiKey
    return h
  }

  /**
   * Register a session; secrets (access_code, bridge_token) return once.
   *
   * Bounded by `timeoutMs`, answer body included: `start` runs it before
   * anything is printed, and a relay that never answers must fail the start
   * with a reason rather than hold it until the plugin cancels it.
   *
   * `ownerKey` (see state.ts ownerKey) proves the id is this install's: the
   * relay reserves an id for the key it was registered with, and lets the
   * same key replace its own registration. A relay that predates it ignores
   * the field.
   *
   * `accessCode` is the code this install recorded for a share of this id that
   * is still registered here (see resumableCode in index.ts). Presented
   * together with a matching owner key, the relay CONTINUES that share instead
   * of replacing it: the same code keeps working and the viewers already in
   * stay in — which matters because they are typically somewhere else
   * entirely, and the code only ever existed on this machine. It is a proof,
   * never a request: the relay holds a salted hash, so it recognises the code
   * it minted and can neither restore nor be told one. A relay that predates
   * the field ignores it and answers with a new code, which is what happened
   * before, so nothing here has to know which kind of relay it is talking to.
   */
  async createSession(
    sessionId: string,
    directory: string,
    title: string,
    ownerKey?: string,
    accessCode?: string,
    timeoutMs = relayRegisterTimeoutMs(),
  ): Promise<RelaySession> {
    try {
      // fetchFrom: a relay that cannot be reached is named, with the reason —
      // "fetch failed" alone read the same as a dead local opencode.
      const res = await fetchFrom('relay', `${this.url}/api/sessions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          session_id: sessionId,
          directory,
          title,
          ...(ownerKey === undefined ? {} : { owner_key: ownerKey }),
          ...(accessCode === undefined ? {} : { access_code: accessCode }),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      // Read under the same timeout as the answer itself (the signal above).
      if (!res.ok) throw new RelayHttpError(res.status, `relay createSession failed: ${res.status}`, await relayErrorOf(res))
      const session = parseRelaySession(await res.json().catch(() => null))
      if (!session) throw new Error('relay createSession failed: the answer is not a session this bridge can serve')
      return session
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`relay createSession failed: no answer within ${timeoutMs / 1000} s`)
      }
      throw err
    }
  }

  /**
   * End a session on the relay. Requires the session's own bridge_token.
   *
   * Bounded by `timeoutMs` (rejects with a TimeoutError): every caller runs it
   * while shutting a share down, and a relay that never answers must not be
   * able to hold that shutdown open.
   */
  async deleteSession(sessionId: string, bridgeToken: string, timeoutMs = relayDeleteTimeoutMs()): Promise<number> {
    const res = await fetchFrom('relay', `${this.url}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { ...this.headers(), 'x-bridge-token': bridgeToken },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.status
  }

  /**
   * Session status probe for `bridge status`. Returns parsed body + HTTP status.
   *
   * Bounded by `timeoutMs` (rejects with a TimeoutError), as deleteSession is:
   * `status` asks the relay a share was registered on, which after a move to
   * another relay may be one that accepts the connection and never answers —
   * and the plugin kills a status that takes 15 s, with nothing said about why.
   */
  async getSession(
    sessionId: string,
    bridgeToken?: string,
    timeoutMs = relayDeleteTimeoutMs(),
  ): Promise<{ status: number; body?: SessionStatus }> {
    const res = await fetchFrom('relay', `${this.url}/api/sessions/${encodeURIComponent(sessionId)}`, {
      // The bridge_token unlocks the owner-only fields (directory, title) that
      // the public presence view withholds.
      headers: { ...this.headers(), ...(bridgeToken ? { 'x-bridge-token': bridgeToken } : {}) },
      // Covers reading the body below too.
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status !== 200) return { status: res.status }
    return { status: 200, body: parseSessionStatus(await res.json().catch(() => null), Boolean(bridgeToken)) }
  }
}

/* -------------------------- bridge-side path allowlist -------------------------- */

/** The only verbs the relay proxy protocol ever legitimately carries. */
type ProxyMethod = 'GET' | 'POST'

/**
 * What the relay may ask THIS machine to do.
 *
 * A `proxy` frame hands us a method and a path that land verbatim on the local
 * opencode server — a server that runs shell commands, reads any file and
 * rewrites the project. The only allowlist used to live in the relay
 * (relay/src/proxy/adapter.ts), i.e. on a host the bridge merely dials: a
 * compromised, swapped or DNS-hijacked relay could drive any verb at any path
 * against every connected user's machine, which is remote code execution on
 * their laptop. The check has to exist on the side that pays for it being
 * wrong, so the same surface is re-derived here.
 *
 * This table is a SUPERSET of what the relay actually sends: every entry of the
 * relay's ALLOWED_ROUTES, plus the paths its own handlers build rather than
 * template (`/project`, `/project/current`, `/permission`, `/question`,
 * `/session/status`, and `/session/<ses_…>` from the subagent ancestry walk).
 * Each entry also covers its `/api/…` twin — the opencode web UI speaks both
 * dialects against the same server and the relay mounts both.
 *
 * ':id' is the SHARED session — the id this bridge registered, and nothing
 * else. On the routes of SUBAGENT_ROUTES it may also be a session that
 * descends from it, which is proven against the local opencode before the
 * request is forwarded (guardSessionId), never taken from the relay's word.
 * ':messageID' / ':permissionID' / ':requestID' stand for one opaque path
 * segment (the relay percent-encodes them).
 */
const RELAY_PROXY_ROUTES: ReadonlyArray<readonly [ProxyMethod, string]> = [
  // Session detail + messages (relay ALLOWED_ROUTES; ':id' is the viewer's
  // bound session, or one of its subagents on the relay's SUBAGENT_ROUTES —
  // the detail, the transcript reads and the permission answer).
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
  // Not '/session/:id/fork': it creates a new root session outside the share,
  // and the relay does not route it.
  ['POST', '/session/:id/permissions/:permissionID'],
  ['GET', '/session/:id/todo'],
  ['GET', '/session/:id/children'],
  ['GET', '/session/:id/diff'],
  // Read-only global metadata the UI needs to boot.
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
  // The review panel's git / branch diff, a read. Not '/vcs/diff/raw', and
  // never '/vcs/apply': that one writes a patch into the working tree.
  ['GET', '/vcs/diff'],
  ['GET', '/mcp'],
  ['GET', '/lsp'],
  ['GET', '/formatter'],
  ['GET', '/experimental/tool'],
  ['GET', '/experimental/tool/ids'],
  // Read-only project browsing (the UI's file tree and previews).
  ['GET', '/file'],
  ['GET', '/file/content'],
  ['GET', '/file/status'],
  ['GET', '/find'],
  ['GET', '/find/file'],
  ['GET', '/find/symbol'],
  // Global v2 surface probed at boot. NOTE: '/global/event' and '/event' are
  // deliberately absent — the SSE stream is never proxied. The bridge opens it
  // itself (startEventForwarding) and the relay fans it out locally from that
  // subscription, so a `proxy` frame asking for it is by definition not the
  // relay doing its job.
  ['GET', '/global/health'],
  ['GET', '/global/config'],
  // Question API: the pending list (the relay filters it to the viewer's
  // session) and the question dock's answer / dismiss. opencode has no
  // POST /question. Reply and reject are additionally ownership-checked in
  // guardRequest: upstream acts on any request id, whatever its session, so
  // only the bound session's and its subagents' questions pass.
  ['GET', '/question'],
  ['POST', '/question/:requestID/reply'],
  ['POST', '/question/:requestID/reject'],
  // Resource / reference APIs the UI bootstrap resolves.
  ['GET', '/experimental/resource'],
  ['GET', '/experimental/capabilities'],
  ['GET', '/experimental/workspace'],
  ['GET', '/api/reference'],
  ['GET', '/api/agent'],
  ['GET', '/api/command'],
  ['GET', '/api/skill'],
  ['GET', '/skill'],
  ['GET', '/pty'],
  ['GET', '/pty/shells'],
  // UI telemetry.
  ['POST', '/log'],
  // Built by the relay's own handlers, not by a route template: the filtered
  // permission list and the per-session status map.
  ['GET', '/permission'],
  ['GET', '/session/status'],
]

/**
 * Both dialects of every route, indexed by verb. The relay serves `/session/…`
 * and `/api/session/…` from the same handlers, and forwards a few routes
 * (`/api/reference`, `/api/skill`, …) under the prefix verbatim — so each
 * template is allowed with and without it.
 */
const PROXY_TEMPLATES: ReadonlyMap<ProxyMethod, readonly string[]> = (() => {
  const byMethod = new Map<ProxyMethod, string[]>([
    ['GET', []],
    ['POST', []],
  ])
  for (const [method, template] of RELAY_PROXY_ROUTES) {
    const list = byMethod.get(method)!
    list.push(template)
    list.push(template.startsWith('/api/') ? template.slice(4) : `/api${template}`)
  }
  return byMethod
})()

/**
 * Routes where ':id' may name a SUBAGENT of the shared session instead of the
 * session itself — the relay's SUBAGENT_ROUTES, template for template, because
 * a route this set omits is one the relay collapses to the bound session and
 * therefore never legitimately sends with another id.
 *
 * The task tool runs a subagent in a child session, and the web UI reads the
 * child's detail, transcript, todo and diff to render the tree and answers the
 * permission the child raised at the child's own id. Everything else — shell,
 * prompt_async, command, abort, revert, summarize, the children listing — is
 * the share's own session or nothing: those are the routes that RUN something,
 * and on another session of the owner that is code executing in another one of
 * their projects.
 */
const SUBAGENT_ROUTES: ReadonlySet<string> = new Set([
  '/session/:id',
  '/session/:id/message',
  '/session/:id/message/:messageID',
  '/session/:id/todo',
  '/session/:id/diff',
  '/session/:id/permissions/:permissionID',
])

/** A route without its '/api' dialect prefix — the spelling SUBAGENT_ROUTES is written in. */
function bareTemplate(template: string): string {
  return template.startsWith('/api/session/') ? template.slice(4) : template
}

/** A real opencode session id — the shape the relay pins every ':id' to. */
const SESSION_ID_RE = /^ses_[A-Za-z0-9_-]+$/

/**
 * Max parent hops the ownership guards walk from a subagent to the bound
 * session. Subagent nesting is shallow; this only bounds a pathological chain
 * (the relay's own ancestry walk uses the same depth).
 */
const MAX_SUBAGENT_DEPTH = 8

/**
 * Subagent sessions whose descent from the share has been proven, remembered
 * so the walk is not repeated on every poll of a child's transcript. Bounded
 * (the relay's ancestry cache uses the same number): a share with more live
 * subagents than this only pays for the walk again, and losing a positive
 * costs correctness nothing — it is an optimisation, never the authority.
 */
const MAX_PROVEN_DESCENDANTS = 256

/**
 * Add `value`, evicting the oldest entry when full. A Set iterates in
 * insertion order, so the first entry is the oldest; a value seen again moves
 * to the newest end, so a subagent that keeps working is not the one evicted.
 */
function rememberBounded(set: Set<string>, value: string, max: number): void {
  if (set.delete(value)) {
    set.add(value)
    return
  }
  while (set.size >= max) {
    const oldest = set.values().next().value
    if (oldest === undefined) break
    set.delete(oldest)
  }
  set.add(value)
}

/**
 * Ids of messages and parts the bridge has seen belong to a session OUTSIDE
 * the share, learned from the event stream it forwards. Bounded; the oldest
 * goes first.
 *
 * A write names its target twice — in the path and again in the body — and
 * opencode acts on the body: a POST to the shared session carrying another
 * session's `messageID` or `parts[].id` appends to, or overwrites a part of,
 * that other session (measured on 1.18.31; its reads check ownership, its
 * writes do not). Nothing about an id says whose it is — the viewer's browser
 * mints them, so neither their shape nor the timestamp inside them can be
 * trusted — and opencode offers no way to ask. What the bridge does have is
 * position: it is the one subscribed to /event, so every id the relay could
 * have learned about another session of the owner passed through here first.
 */
const MAX_FOREIGN_OBJECTS = 4096

/** The key every opencode event names its session under, as its JSON spells it. */
const EVENT_SESSION_KEY = '"sessionID":"'

/**
 * The shape of an opencode object id (`msg_…`, `prt_…`). Bodies that name
 * something else are not the web UI talking: opencode interpolates these into
 * storage keys, and a path or an absurd length there is nothing this bridge
 * should be passing on.
 */
const OBJECT_ID_RE = /^[a-z]{2,12}_[A-Za-z0-9]{1,120}$/

/**
 * The ids a request body names: the message it writes and the parts it writes
 * into it (`partID` is revert's spelling of the same thing). Only the shapes
 * opencode itself reads — a value that is not a string is returned as it is,
 * for the caller to refuse.
 */
function bodyObjectIds(body: unknown): unknown[] {
  if (body === null || typeof body !== 'object') return []
  const raw = body as { messageID?: unknown; partID?: unknown; parts?: unknown }
  const ids: unknown[] = []
  if (raw.messageID !== undefined) ids.push(raw.messageID)
  if (raw.partID !== undefined) ids.push(raw.partID)
  if (Array.isArray(raw.parts)) {
    for (const part of raw.parts) {
      const id = (part as { id?: unknown } | null)?.id
      if (id !== undefined) ids.push(id)
    }
  }
  return ids
}

/**
 * Why a guard refused a request, and with which status. The status is not
 * decoration: the relay's own ancestry walk reads a 404 as "not a descendant"
 * and anything else as "I could not find out" (see guardSessionId).
 */
interface GuardRefusal {
  status: number
  error: string
}

let warnedAllowAny = false

/**
 * Forward-compatibility escape hatch. A route added to a newer relay would
 * otherwise be refused by every bridge that has not been updated, bricking the
 * feature with no way out — so allow an operator to opt back into the old
 * "trust the relay" behaviour, loudly and deliberately.
 */
function allowAnyPath(): boolean {
  if (process.env.REMOTE_CONTROL_ALLOW_ANY_PATH !== '1') return false
  if (!warnedAllowAny) {
    warnedAllowAny = true
    console.warn(
      'WARNING: REMOTE_CONTROL_ALLOW_ANY_PATH=1 — this bridge will forward ANY method/path the relay sends to your local opencode server. Unset it unless you are debugging a new relay route.',
    )
  }
  return true
}

/**
 * Whether one path segment may stand in for an id.
 *
 * A segment must stay ONE segment: fetch() re-normalises a percent-encoded dot
 * segment ('%2e%2e') and an encoded slash can reopen the path structure the
 * template just fixed, so judge the decoded value. A NUL truncates the URL for
 * anything downstream that speaks C strings. Malformed percent escapes throw
 * on decode and are refused rather than guessed at.
 */
function isSafeIdSegment(raw: string): boolean {
  if (raw.length === 0 || raw.includes('\0')) return false
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return false
  }
  if (/[/\\\0]/.test(decoded)) return false
  return decoded !== '.' && decoded !== '..'
}

/**
 * Whether ':id' may be this value on this route.
 *
 * The bound session always may: the relay force-binds ':id' to the session the
 * bridge registered, and that id is whatever the local opencode called it.
 * ANOTHER session may only where a subagent legitimately appears
 * (SUBAGENT_ROUTES), and only as far as the shape goes — that it really
 * descends from the share is proven against opencode in guardSessionId, which
 * this synchronous check cannot do. Without a bound session nothing
 * session-scoped passes: there is then no share to be inside of.
 */
function isAllowedSessionSegment(raw: string, template: string, boundSessionId?: string | null): boolean {
  if (!boundSessionId) return false
  if (raw === boundSessionId) return true
  return SUBAGENT_ROUTES.has(bareTemplate(template)) && SESSION_ID_RE.test(raw)
}

function matchesTemplate(template: string, pathname: string, boundSessionId?: string | null): boolean {
  const want = template.split('/')
  const got = pathname.split('/')
  if (want.length !== got.length) return false
  for (let i = 0; i < want.length; i++) {
    const segment = want[i]!
    const value = got[i]!
    if (segment.startsWith(':')) {
      if (!isSafeIdSegment(value)) return false
      if (segment === ':id' && !isAllowedSessionSegment(value, template, boundSessionId)) return false
    } else if (segment !== value) {
      return false
    }
  }
  return true
}

/**
 * The value a matched template's `:name` segment took, or undefined when the
 * template has no such segment.
 */
function segmentOf(template: string, pathname: string, name: string): string | undefined {
  const at = template.split('/').indexOf(name)
  return at === -1 ? undefined : pathname.split('/')[at]
}

/** Stands in for a template when the operator opened the gate (see allowAnyPath). */
const ANY_TEMPLATE = '*'

/**
 * The allowlist template a relay-supplied method+path matches, or undefined
 * when none does. The template is what tells the guards which segment is the
 * session and whether a subagent may stand in for it.
 */
function matchProxyRoute(method: string, path: string, boundSessionId?: string | null): string | undefined {
  if (allowAnyPath()) return ANY_TEMPLATE
  const verb = method.toUpperCase()
  if (verb !== 'GET' && verb !== 'POST') return undefined
  const templates = PROXY_TEMPLATES.get(verb)
  if (!templates) return undefined
  // The relay appends its own ?directory=… to every forwarded path, so match
  // the pathname alone — a query can only ever reach the endpoint the path
  // already named, and a fragment never leaves fetch() at all.
  const pathname = path.split(/[?#]/)[0] ?? ''
  if (!pathname.startsWith('/')) return undefined
  return templates.find((template) => matchesTemplate(template, pathname, boundSessionId))
}

/**
 * Whether a relay-supplied method+path may be forwarded to local opencode.
 * Exported so the allowlist can be tested directly, without a socket.
 *
 * `boundSessionId` is this bridge's own session (see isAllowedSessionSegment).
 */
export function isProxyRequestAllowed(method: string, path: string, boundSessionId?: string | null): boolean {
  return matchProxyRoute(method, path, boundSessionId) !== undefined
}

/**
 * The query ('' or '?…', fragment dropped) of a relay-forwarded path. It
 * carries the ?directory=… the relay pins, which picks the opencode instance
 * the request acts on — the ownership guards read their pending lists there.
 */
function queryOfPath(path: string): string {
  const queryStart = path.indexOf('?')
  return queryStart === -1 ? '' : path.slice(queryStart).split('#')[0]!
}

/** method+path pairs already reported, so one confused relay cannot spam the
 * log (and cannot grow this set without bound either). */
const warnedRejections = new Set<string>()
const MAX_LOGGED_REJECTIONS = 50

let failedRelayMessages = 0

/** Log a relay frame whose handling threw — a bug, so visible, but budgeted. */
function warnFailedRelayMessage(err: unknown): void {
  if (++failedRelayMessages > MAX_LOGGED_REJECTIONS) return
  console.warn(`bridge: failed to handle a relay message: ${err instanceof Error ? err.message : 'unknown error'}`)
}

/**
 * Log a failed re-dial of the relay. Failures used to be silent, which is how
 * a share that stopped reconnecting left nothing in the log. A relay that is
 * down for hours must not flood it either, so only attempts 1, 2, 4, 8, … of
 * one outage are reported; the count starts over once a dial succeeds.
 */
function warnFailedRedial(attempt: number, err: unknown): void {
  if (attempt < 1 || (attempt & (attempt - 1)) !== 0) return
  console.warn(`bridge: relay re-dial #${attempt} failed: ${err instanceof Error ? err.message : 'unknown error'} — retrying`)
}

/**
 * Report a refused proxy request exactly once. A relay that asks for something
 * outside the contract is either compromised or newer than this bridge — both
 * are worth seeing in the terminal instead of failing silently.
 */
function warnRejectedProxyRequest(method: string, path: string): void {
  // Both halves are the relay's text, and this line goes to a terminal and to
  // bridge.log: a path carrying an escape sequence could otherwise repaint the
  // owner's screen or forge lines around itself (see safeForTerminal).
  const key = safeForTerminal(`${method} ${path.split(/[?#]/)[0] ?? ''}`, 256)
  if (warnedRejections.has(key) || warnedRejections.size >= MAX_LOGGED_REJECTIONS) return
  warnedRejections.add(key)
  console.warn(
    `bridge: refused a relay request outside the allowlist: ${key} (set REMOTE_CONTROL_ALLOW_ANY_PATH=1 only if you trust this relay)`,
  )
}

/**
 * Response bodies at least this large are gzipped when the relay supports it.
 * Below it the saving is a few hundred bytes and not worth a thread-pool trip.
 */
const GZIP_MIN_BYTES = 8 * 1024
/**
 * Protocol limit, mirrored from the relay (relay/src/ws/bridge.ts
 * GZIP_MAX_RATIO): the relay refuses to inflate a body past this multiple of
 * its compressed size, so a body that compresses better goes uncompressed.
 */
const GZIP_MAX_RATIO = 32
/**
 * Fallback frame cap for a relay that does not announce its own.
 *
 * The real ceiling is the relay's maxPayload, and a relay new enough names it
 * in the hello ('max-frame-bytes=<n>' — see relayMaxFrameBytes). This number
 * is what the relays that say nothing were built around, so it is what they
 * still accept; it is not this bridge's to choose, and raising it here would
 * only mean sending them frames they terminate the link over.
 */
const GZIP_MAX_OUTPUT_BYTES = 100 * 1024 * 1024

/**
 * The frame cap a relay's hello announces, or undefined when it announces
 * none (an older relay, or a feature list that is not ours to parse).
 *
 * Only ever narrows what this bridge sends, and only to a positive finite
 * number: a relay that names something absurd — or a hostile one, since the
 * bridge does not trust the relay any more than the other way round — cannot
 * use this to make the bridge send frames the real relay would refuse.
 */
function announcedFrameCap(features: unknown): number | undefined {
  if (!Array.isArray(features)) return undefined
  for (const feature of features) {
    if (typeof feature !== 'string' || !feature.startsWith('max-frame-bytes=')) continue
    const value = Number(feature.slice('max-frame-bytes='.length))
    if (Number.isFinite(value) && value > 0) return Math.min(value, GZIP_MAX_OUTPUT_BYTES)
  }
  return undefined
}

/** One line, once, about frames dropped for the relay's cap — see send(). */
let warnedOversizedFrame = false
function warnOversizedFrame(kind: string, bytes: number, cap: number): void {
  if (warnedOversizedFrame) return
  warnedOversizedFrame = true
  console.warn(
    `bridge: a ${kind} of ${bytes} bytes exceeds the relay's ${cap}-byte frame limit and was not sent ` +
      `(sending it would drop the link and every request on it)`,
  )
}

/** Consecutive keep-alive intervals with no progress at all before a link is dead. */
const KEEPALIVE_STRIKES = 2

/** What one keep-alive tick observed about the link since the previous one. */
export interface LinkSample {
  /** Our ping was answered. */
  pongReceived: boolean
  /** Anything arrived from the relay: a message, its own ping, raw bytes. */
  inboundActivity: boolean
  /** Bytes still waiting in our process at the previous tick (socket writableLength). */
  pendingBefore: number
  /** Bytes whose socket writes had completed, at the previous tick and now. */
  flushedBefore: number
  flushedNow: number
  /**
   * Bytes of the write currently inside libuv that the OS has not yet taken,
   * at the previous tick and now. Undefined where the runtime does not expose it.
   */
  osQueueBefore?: number
  osQueueNow?: number
}

/**
 * Did the link move since the last tick?
 *
 * Inbound traffic is proof by itself. Outbound is proof only under one
 * condition, and getting that condition wrong breaks dead-link detection:
 * the OS takes bytes into its send buffer whether or not the peer is still
 * there, so on a half-open link our own few-byte pings "leave" forever. What
 * the OS cannot do on a dead link is make ROOM — only the peer's ACKs free
 * send-buffer space. So outbound movement counts only if data was already
 * backed up in our process at the previous tick (the OS buffer was full) and
 * the OS has taken more of it since.
 *
 * "Taken more" cannot be read off `bufferedAmount` either. That number drops
 * only when a whole socket write completes, and one frame is one write: a
 * multi-megabyte proxy response on a 2 Mbit/s uplink needs longer than two
 * keep-alive intervals to leave, and `bufferedAmount` sits still the whole
 * time. Two counters, together exact:
 *   - flushed (bytesWritten - writableLength) grows when a write completes;
 *   - the libuv write queue shrinks while a write is partway through.
 * A new write starts only after the previous one completed, so the queue can
 * only grow when `flushed` did — neither moves without bytes leaving.
 */
export function linkMadeProgress(s: LinkSample): boolean {
  if (s.pongReceived || s.inboundActivity) return true
  if (s.pendingBefore <= 0) return false
  if (s.flushedNow > s.flushedBefore) return true
  return s.osQueueBefore !== undefined && s.osQueueNow !== undefined && s.osQueueNow < s.osQueueBefore
}

/** Outbound counters of a raw socket — see linkMadeProgress. */
function outboundCounters(socket: Socket | null): { pending: number; flushed: number; osQueue?: number } {
  if (!socket) return { pending: 0, flushed: 0 }
  // `_handle.writeQueueSize` is libuv's own count, exposed by Node's stream
  // wrap on every version this runs on (checked on 18 and 26). Read defensively:
  // without it only whole-frame progress is seen — still correct, just coarser.
  const handle = (socket as unknown as { _handle?: { writeQueueSize?: unknown } | null })._handle
  const osQueue = typeof handle?.writeQueueSize === 'number' ? handle.writeQueueSize : undefined
  return { pending: socket.writableLength, flushed: socket.bytesWritten - socket.writableLength, osQueue }
}

/**
 * WebSocket client for the relay's /bridge endpoint.
 *
 * After connect() the socket carries (see relay/src/ws/bridge.ts):
 *   relay → bridge: { type: 'hello', features }  (first frame; newer relays only.
 *                   'gzip-body' and 'max-frame-bytes=<n>' — see
 *                   sendProxyResponse and relayMaxFrameBytes)
 *   relay → bridge: { type: 'proxy', request_id, method, path, body? }
 *   bridge → relay: { type: 'proxy_response', request_id, status, contentType, nextCursor?, body }
 *                   or, once the hello offered 'gzip-body', a binary frame
 *                   (see sendProxyResponse)
 *   bridge → relay: { type: 'event', data }  (from startEventForwarding)
 */
export class RelayWSClient {
  private ws: WebSocket | null = null
  private eventAbortController: AbortController | null = null
  private boundSessionId: string | null = null
  private bridgeToken: string | null = null
  /** Directory of the shared session; scopes the opencode event stream and pins every forwarded query. */
  private sessionDirectory: string | undefined
  /** Sessions proven to descend from the bound one — see sharesTree. */
  private readonly provenDescendants = new Set<string>()
  /** Proxy requests being served right now — see maxInflightProxyRequests. */
  private inflightProxy = 0
  /** Message and part ids seen on the stream under a foreign session — see MAX_FOREIGN_OBJECTS. */
  private readonly foreignObjects = new Map<string, string>()
  /** Set by close(): stops the keep-alive and every retry loop for good. */
  private stopped = false
  /** Set when the relay rejected us — retrying can never succeed. */
  private fatal = false
  private keepAlive: NodeJS.Timeout | null = null
  /** Liveness evidence gathered since the last keep-alive tick — see linkMadeProgress. */
  private pongSinceTick = false
  private inboundSinceTick = false
  /** The socket under the current WebSocket — its counters measure outbound progress. */
  private rawSocket: Socket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private forwardingEvents = false
  /** The relay on the CURRENT socket said it accepts gzipped response bodies. */
  private relayAcceptsGzip = false
  /**
   * The largest frame the relay on the CURRENT socket accepts, from its hello.
   * A frame past it is not a failed request: ws answers it with a protocol
   * error and the relay terminates the link, failing everything else in flight
   * and leaving every viewer a gap. Knowing the number lets send() degrade
   * instead. GZIP_MAX_OUTPUT_BYTES until a relay says otherwise, which is the
   * ceiling relays that announce nothing were built around.
   */
  private relayMaxFrameBytes = GZIP_MAX_OUTPUT_BYTES
  /** Called when the relay rejects our credentials — the share is gone. */
  onFatal: ((err: Error) => void) | null = null
  /** Test/diagnostic hook: fired after every successful (re)connection. */
  onReconnect: (() => void) | null = null

  constructor(
    public relayUrl: string,
    private opencode: OpencodeClient,
  ) {}

  /**
   * Connect to the relay's /bridge endpoint. Resolves once the socket is
   * open; rejects if the relay refuses the credentials (close 4003) or the
   * connection fails before opening.
   */
  connect(session_id: string, bridge_token: string, directory?: string): Promise<void> {
    this.boundSessionId = session_id
    this.bridgeToken = bridge_token
    // Scopes the /event subscription — see OpencodeClient.getEvent.
    this.sessionDirectory = directory
    return this.dial()
  }

  /** Open one socket and wire keep-alive + reconnect onto it. */
  private dial(): Promise<void> {
    const session_id = this.boundSessionId!
    const base = this.relayUrl.replace(/^http/, 'ws')
    const url = `${base}/bridge?session_id=${encodeURIComponent(session_id)}`
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { 'x-bridge-token': this.bridgeToken! },
        // Nothing else watches a socket that has not opened: keep-alive starts
        // at 'open', ws sets no deadline unless asked, and the next re-dial is
        // only scheduled once this one fails. A dial whose bytes were delivered
        // but never answered (the laptop slept or switched networks right
        // after, a captive portal holding :443, an upgrade nginx accepted and
        // sat on) stayed CONNECTING for good, and the share with it, silently.
        // Timing out makes it an ordinary transport error the backoff retries.
        // ws clears the timeout once the upgrade succeeds, so an open link,
        // however quiet, is never cut by it.
        handshakeTimeout: wsHandshakeTimeoutMs(),
        // What the RELAY may put in one frame. ws otherwise allows its own
        // 100 MiB default and buffers the whole thing here first — see
        // relayMaxPayloadBytes.
        maxPayload: relayMaxPayloadBytes(),
      })
      this.ws = ws
      // Per socket: a relay announces what it understands in its first frame,
      // and a reconnect may land on a different (older) relay.
      this.relayAcceptsGzip = false
      this.relayMaxFrameBytes = GZIP_MAX_OUTPUT_BYTES
      let opened = false
      ws.on('open', () => {
        opened = true
        this.reconnectAttempt = 0
        // Listen for raw bytes only now, never in 'upgrade'. There `ws` has not
        // attached its own reader yet and still has to hand back the bytes that
        // arrived with the 101 response (socket.unshift) — a 'data' listener
        // added first switches the socket to flowing and receives those bytes
        // ALONE, so the relay's first frames silently vanished.
        this.rawSocket?.on('data', () => {
          if (this.ws === ws) this.inboundSinceTick = true
        })
        this.startKeepAlive(ws)
        resolve()
      })
      ws.on('pong', () => {
        this.pongSinceTick = true
      })
      // Anything arriving from the relay proves the path works, whether or not
      // our own ping has been answered: its pings here, and raw bytes (see
      // 'open') so a large frame still in transit — a viewer posting a big
      // prompt over a slow downlink — counts as life before it is complete.
      ws.on('ping', () => {
        this.inboundSinceTick = true
      })
      ws.on('upgrade', (res) => {
        this.rawSocket = res.socket
      })
      // The relay refuses the UPGRADE (HTTP 401) when the session is gone —
      // it was stopped elsewhere, or the relay restarted and lost it. Every
      // re-dial would be refused the same way, so this ends the share instead
      // of looping. Transport failures stay retryable: that is the point.
      // Note: with a listener attached, ws stops emitting 'error' for this
      // case and leaves the socket to us — so settle and tear down here.
      ws.on('unexpected-response', (_req, res) => {
        const status = res.statusCode ?? 0
        const err = new Error(`relay rejected the bridge (HTTP ${status})`)
        if (status === 401 || status === 403) {
          this.fatal = true
          this.onFatal?.(err)
        }
        res.resume()
        ws.terminate()
        if (this.ws === ws) this.ws = null
        if (!opened) reject(err)
        else if (!this.fatal) this.scheduleReconnect()
      })
      ws.on('error', (err) => {
        if (!opened) reject(err)
      })
      ws.on('close', (code) => {
        if (!opened) {
          reject(new Error(`relay refused bridge connection (close code ${code})`))
          return
        }
        if (this.ws !== ws) return
        this.ws = null
        this.stopKeepAlive()
        // 4001/4003 mean the relay dropped us on purpose (session closed or
        // credentials rejected): re-dialling would loop forever.
        if (code === 4001 || code === 4003) {
          this.fatal = true
          this.onFatal?.(new Error(`relay closed the bridge (code ${code})`))
          return
        }
        this.scheduleReconnect()
      })
      ws.on('message', (raw) => {
        // Never fire-and-forget: an unhandled rejection ends the Node process,
        // so one frame this handler did not anticipate would take the share down.
        this.onMessage(raw).catch(warnFailedRelayMessage)
      })
    })
  }

  /**
   * Prove the link is alive — by PROGRESS, not by pongs alone.
   *
   * A half-open socket still reports OPEN, so something has to notice when the
   * network is gone. But a saturated uplink is not a gone network, and treating
   * it as one was the bug: our ping is written to the same socket as the data,
   * so behind megabytes of queued transcript it simply never reaches the relay
   * in time. No pong can come back, bytes keep leaving the whole while, and the
   * old rule — no pong by the next tick means dead — terminated a working link
   * and discarded every request in flight (the viewer's 502 "proxy failed").
   *
   * So a tick asks whether ANYTHING happened: an answer to our ping, any
   * traffic from the relay, or a backed-up send queue that the peer's ACKs are
   * still draining. Only KEEPALIVE_STRIKES consecutive ticks with none of those
   * end the socket — the same two intervals a truly silent link took to detect
   * before, so dead links are caught no later than they were.
   */
  private startKeepAlive(ws: WebSocket): void {
    this.stopKeepAlive()
    const socket = this.rawSocket
    let strikes = 0
    let last = outboundCounters(socket)
    const openedAt = Date.now()
    const timer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return
      const now = outboundCounters(socket)
      const progress = linkMadeProgress({
        pongReceived: this.pongSinceTick,
        inboundActivity: this.inboundSinceTick,
        pendingBefore: last.pending,
        flushedBefore: last.flushed,
        flushedNow: now.flushed,
        osQueueBefore: last.osQueue,
        osQueueNow: now.osQueue,
      })
      this.pongSinceTick = false
      this.inboundSinceTick = false
      last = now
      if (progress) {
        strikes = 0
      } else if (++strikes >= KEEPALIVE_STRIKES) {
        // Logged because the alternative is a share that silently cycles: this
        // line, with the queue size, is what tells "dead" from "congested".
        console.warn(
          `bridge: relay link silent for ${strikes} keep-alive intervals ` +
            `(up ${Math.round((Date.now() - openedAt) / 1000)}s, ${ws.bufferedAmount} bytes queued) — reconnecting`,
        )
        ws.terminate()
        return
      }
      try {
        ws.ping()
      } catch {
        ws.terminate()
      }
    }, wsPingIntervalMs())
    timer.unref?.()
    this.keepAlive = timer
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.keepAlive = null
    this.pongSinceTick = false
    this.inboundSinceTick = false
  }

  /** Re-dial with exponential backoff until it works or close() is called. */
  private scheduleReconnect(): void {
    if (this.stopped || this.fatal || this.reconnectTimer) return
    this.reconnectAttempt += 1
    const timer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped || this.fatal) return
      this.dial()
        .then(() => {
          // The event stream is per-connection state on the relay side: a new
          // socket has no subscribers until we push again, and the local SSE
          // reader may have ended while we were offline.
          // Never fire-and-forget: opencode may be unreachable right now (it
          // restarts, the machine wakes up), and an unhandled rejection ends
          // the Node process — the share would die on the very blip this
          // reconnect exists to survive. Failures retry like any lost stream.
          if (!this.forwardingEvents) this.startEventForwarding().catch(() => this.scheduleEventRestart())
          this.onReconnect?.()
        })
        .catch((err) => {
          warnFailedRedial(this.reconnectAttempt, err)
          this.scheduleReconnect()
        })
    }, backoffDelay(this.reconnectAttempt))
    timer.unref?.()
    this.reconnectTimer = timer
  }

  /**
   * Subscribe to opencode's /event SSE stream and push each event to the
   * relay. The stream ends whenever the local server restarts or the read
   * fails, so it re-subscribes until close() — otherwise the share would stay
   * connected but silent, with no events reaching any viewer.
   */
  async startEventForwarding(): Promise<void> {
    this.eventAbortController = new AbortController()
    const stream = await this.opencode.getEvent(this.eventAbortController.signal, this.sessionDirectory)
    if (!stream) throw new Error('opencode /event stream unavailable')
    this.forwardingEvents = true
    void readSseStream(
      stream,
      (data) => {
        // Before the relay sees it: what is on this stream is what the relay
        // can name back at us (see foreignObjects).
        this.noteForeignObjects(data)
        this.send({ type: 'event', data })
      },
      () => this.waitForSendRoom(),
    ).finally(() => {
      this.forwardingEvents = false
      this.scheduleEventRestart()
    })
  }

  /**
   * Backpressure for event forwarding: resolves once the relay socket's send
   * queue is below the high-water mark.
   *
   * Without it the queue had no bound at all. opencode emits events as fast as
   * the model writes, a home uplink carries ~2 Mbit/s, and everything that did
   * not fit piled up in this process — 4.5 MB was measured in the field. Every
   * viewer request answered meanwhile queued behind that pile, so a click on
   * the iPad waited for megabytes of old events to leave first. Pausing the
   * read pushes the wait back to opencode's stream, where it costs nothing,
   * and keeps request answers a bounded few seconds from the front.
   *
   * With no open socket there is nothing to wait for: send() drops events
   * while offline, exactly as before.
   */
  private async waitForSendRoom(): Promise<void> {
    const highWater = eventHighWaterBytes()
    for (;;) {
      const ws = this.ws
      if (this.stopped || !ws || ws.readyState !== WebSocket.OPEN) return
      if (ws.bufferedAmount < highWater) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  private scheduleEventRestart(): void {
    if (this.stopped) return
    const timer = setTimeout(() => {
      if (this.stopped || this.forwardingEvents) return
      this.startEventForwarding().catch(() => this.scheduleEventRestart())
    }, eventRetryMs())
    timer.unref?.()
  }

  close() {
    this.stopped = true
    this.stopKeepAlive()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.eventAbortController?.abort()
    this.eventAbortController = null
    this.ws?.close()
  }

  private async onMessage(raw: WebSocket.RawData): Promise<void> {
    let msg: { type?: string; request_id?: string; method?: unknown; path?: unknown; body?: unknown }
    try {
      const parsed: unknown = JSON.parse(String(raw))
      // Valid JSON that is not an object is not a frame: `null` (which reads
      // `.type` off nothing), a number, a string, an array. The relay is not
      // trusted — that is the whole reason the allowlist is derived again on
      // this side — so a frame it sends is dropped like unparsable bytes,
      // rather than thrown out of the handler and logged as a bug in handling
      // it. The same frame used to end the relay process; see
      // relay/src/ws/bridge.ts.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      msg = parsed as typeof msg
    } catch {
      return
    }
    if (msg.type === 'hello') {
      const features = (msg as { features?: unknown }).features
      this.relayAcceptsGzip = Array.isArray(features) && features.includes('gzip-body')
      this.relayMaxFrameBytes = announcedFrameCap(features) ?? GZIP_MAX_OUTPUT_BYTES
      return
    }
    if (msg.type !== 'proxy' || typeof msg.request_id !== 'string') return
    const method: unknown = msg.method ?? 'GET'
    const path: unknown = msg.path ?? '/'
    // Check before opencode is touched at all: the relay does not get to pick
    // which verb runs against which local endpoint (see RELAY_PROXY_ROUTES).
    // Types first — both come off the wire from a relay this bridge does not
    // trust, and the allowlist calls string methods on them.
    const route =
      typeof method === 'string' && typeof path === 'string'
        ? matchProxyRoute(method, path, this.boundSessionId)
        : undefined
    if (typeof method !== 'string' || typeof path !== 'string' || route === undefined) {
      warnRejectedProxyRequest(
        typeof method === 'string' ? method : `<${typeof method}>`,
        typeof path === 'string' ? path : `<${typeof path}>`,
      )
      this.send({
        type: 'proxy_response',
        request_id: msg.request_id,
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'path not allowed by bridge' }),
      })
      return
    }
    // Past the ceiling, say so at once instead of queueing: a relay that sends
    // more than this is not a viewer clicking, and the owner's machine is the
    // one that would pay for the queue (see maxInflightProxyRequests).
    if (this.inflightProxy >= maxInflightProxyRequests()) {
      this.send({
        type: 'proxy_response',
        request_id: msg.request_id,
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'bridge busy' }),
      })
      return
    }
    // What actually goes to opencode: the path the relay named, with the
    // share's own project pinned into the query (see pinnedQuery). The guards
    // read it too — a pending list must come from the instance the request
    // will act on, which is this one and not the one the relay asked for.
    const forwarded = (path.split(/[?#]/)[0] ?? '') + this.pinnedQuery(queryOfPath(path))
    this.inflightProxy++
    try {
      const refusal = await this.guardRequest(route, method, forwarded, msg.body)
      if (refusal) {
        this.send({
          type: 'proxy_response',
          request_id: msg.request_id,
          status: refusal.status,
          contentType: 'application/json',
          body: JSON.stringify({ error: refusal.error }),
        })
        return
      }
      const out = await this.opencode.request(method, forwarded, msg.body)
      await this.sendProxyResponse(msg.request_id, out)
    } catch {
      this.send({
        type: 'proxy_response',
        request_id: msg.request_id,
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'opencode unreachable' }),
      })
    } finally {
      this.inflightProxy--
    }
  }

  /**
   * Answer a proxy request, gzipping the body when that is worth it.
   *
   * The owner's uplink is the narrowest pipe in the whole path — the field
   * incident was a ~2 Mbit/s home line — and what crosses it is mostly JSON
   * transcript, which compresses 3-10x. Sent as a binary frame the relay only
   * accepts after announcing support (see its hello). A body that compresses
   * better than the relay's inflate limit goes uncompressed: the relay would
   * rightly refuse to expand it.
   */
  private async sendProxyResponse(
    request_id: string,
    out: { status: number; contentType?: string; nextCursor?: string; body: string },
  ): Promise<void> {
    if (this.relayAcceptsGzip && out.body.length >= GZIP_MIN_BYTES) {
      const raw = Buffer.from(out.body, 'utf8')
      const compressed = await new Promise<Buffer | null>((resolve) =>
        gzip(raw, (err, result) => resolve(err ? null : result)),
      )
      const worthIt =
        compressed !== null &&
        compressed.length < raw.length * 0.9 &&
        raw.length <= compressed.length * GZIP_MAX_RATIO &&
        // The relay inflates to at most min(ratio, its frame cap), so a body
        // over the cap is refused however small it was on the wire — and the
        // owner's uplink has already carried it by then. Fall through to the
        // 413 below instead of paying for a 502.
        raw.length <= this.relayMaxFrameBytes
      // Re-checked after the await: the socket may have been replaced by one
      // whose relay has not (or not yet) announced support.
      if (worthIt && this.relayAcceptsGzip && this.ws?.readyState === WebSocket.OPEN) {
        const header = Buffer.from(
          JSON.stringify({
            type: 'proxy_response',
            request_id,
            status: out.status,
            contentType: out.contentType,
            nextCursor: out.nextCursor,
            encoding: 'gzip',
          }),
        )
        const prefix = Buffer.alloc(4)
        prefix.writeUInt32BE(header.length, 0)
        const frame = Buffer.concat([prefix, header, compressed!])
        // A compressed frame is still a frame. It is far below the cap
        // whenever the body was (the ratio check above saw to that), but the
        // limit is on what goes on the wire, so measure what goes on the wire.
        if (frame.length <= this.relayMaxFrameBytes) {
          this.ws.send(frame, { binary: true })
          return
        }
      }
    }
    if (this.send({ type: 'proxy_response', request_id, ...out })) return
    // Too large for this relay's link. Say so to whoever asked instead of
    // putting a frame on the socket that would cost the owner the share — and
    // cost it again on the repeat that follows the reconnect.
    this.send({
      type: 'proxy_response',
      request_id,
      status: 413,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'response too large for the relay link' }),
    })
  }

  /**
   * Put one text frame on the relay socket, unless it is bigger than the relay
   * said it accepts. Returns whether it went.
   *
   * The check lives here, in the single place every text frame passes through,
   * because getting it wrong is not a failed request: the relay answers a frame
   * past its maxPayload with a protocol error and terminates the socket, which
   * fails every other request in flight for this share and leaves every viewer
   * a gap in the event stream — and the relay repeats the GET that caused it as
   * soon as the bridge is back, so the same body takes the link down twice.
   * Dropping the frame costs whoever asked for it one answer; sending it costs
   * everyone the share. Callers that can say something smaller instead (see
   * sendProxyResponse) act on the `false`.
   */
  private send(data: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    const frame = JSON.stringify(data)
    const bytes = Buffer.byteLength(frame)
    if (bytes > this.relayMaxFrameBytes) {
      const type = (data as { type?: unknown } | null)?.type
      warnOversizedFrame(typeof type === 'string' ? type : 'frame', bytes, this.relayMaxFrameBytes)
      return false
    }
    this.ws.send(frame)
    return true
  }

  /**
   * Cross-session guard. The relay force-binds the URL :id to the viewer's
   * session, but upstream opencode's permission reply endpoint does NOT
   * check that the permission request belongs to that session — a viewer
   * could approve a prompt raised by ANOTHER session of the owner. Verify
   * the permission request belongs to the bound session, or to one of its
   * subagents (see sharesTree), before forwarding. Question replies and
   * rejections are checked the same way (see guardQuestion).
   */
  private async guardRequest(
    template: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<GuardRefusal | null> {
    // The relay always appends its own ?directory=… query to the forwarded
    // path, so match the pathname only — otherwise the query lands inside the
    // captured permission id and every viewer reply is rejected as foreign.
    const pathname = path.split(/[?#]/)[0]!
    const foreignSession = await this.guardSessionId(template, pathname, queryOfPath(path))
    if (foreignSession) return foreignSession
    if (method !== 'POST') return null
    // Checked for every POST, not just the ones known to read an id today: a
    // route added later cannot forget to ask, and a body with no id in it
    // costs a walk of three fields.
    const foreignObject = this.guardBodyIds(body)
    if (foreignObject) return foreignObject
    // Both dialects: the allowlist admits the '/api' twin of every route, and
    // a guard that only knew the bare spelling would wave that one through.
    // The permission route used to be matched bare only, so its /api twin
    // skipped the ownership check (opencode 1.18.30 does not route that
    // spelling, but the allowlist lets it through to whatever server does).
    const question = /^(?:\/api)?\/question\/([^/]+)\/(?:reply|reject)$/.exec(pathname)
    if (question) return this.guardQuestion(decodeURIComponent(question[1]!), path)
    const m = /^(?:\/api)?\/session\/[^/]+\/permissions\/([^/]+)$/.exec(pathname)
    if (!m) return null
    const permissionID = decodeURIComponent(m[1]!)
    if (!this.boundSessionId) return null
    const query = queryOfPath(path)
    try {
      // Listed with the forwarded request's own query, like guardQuestion:
      // pending permissions are held per directory instance, and a list
      // without ?directory=… reads the server's own one. That found nothing
      // whenever the shared session lived elsewhere (the desktop app hosting
      // several projects, a server started from another folder), so every
      // viewer answer was refused as foreign.
      const pending = await this.opencode.listPermissions(query)
      const list = Array.isArray(pending) ? pending : []
      for (const p of list) {
        const rec = p as Record<string, unknown> | null
        if (rec?.id !== permissionID && rec?.requestID !== permissionID) continue
        if (await this.sharesTree(rec.sessionID, query)) return null
      }
      return { status: 403, error: 'permission request not found for this session' }
    } catch {
      // If we cannot verify, fail closed.
      return { status: 403, error: 'permission verification unavailable' }
    }
  }

  /**
   * Bind ':id' to the share, for real.
   *
   * The allowlist only checked ':id' for SHAPE, so any `ses_…` the relay put
   * there reached the owner's other sessions — and, with them, their projects:
   * a prompt or a shell in another session is code running in another
   * directory. The rule is the relay's own (readableSessionId), re-derived on
   * the side that pays for it being wrong: the bound session everywhere, a
   * proven descendant of it on the subagent-readable reads, nothing else.
   *
   * Descent is proven by walking parentID through the local opencode
   * (sharesTree) in the request's own instance, and the proof is cached — the
   * web UI reads a subagent's transcript on every poll, and a round trip per
   * poll is a cost the owner's uplink does not need to pay twice.
   */
  private async guardSessionId(template: string, pathname: string, query: string): Promise<GuardRefusal | null> {
    if (template === ANY_TEMPLATE) return null
    const raw = segmentOf(template, pathname, ':id')
    if (raw === undefined) return null
    // Decodes: isSafeIdSegment proved it decodes to exactly one segment.
    const id = decodeURIComponent(raw)
    const bound = this.boundSessionId
    if (!bound) return { status: 403, error: 'no session is bound to this bridge' }
    if (id === bound || this.provenDescendants.has(id)) return null
    const descends = await this.sharesTree(id, query)
    // Both are refusals; the status is how the relay tells them apart. Its own
    // ancestry walk takes a 404 as 'not a descendant' and anything else as 'I
    // could not find out', and serves a different page for each: a foreign id
    // gets the page that says the share ended, while a subagent opencode is
    // momentarily unable to describe must not make a live share look over.
    if (descends === false) return { status: 404, error: 'session not part of this share' }
    if (descends === undefined) return { status: 403, error: 'session ownership could not be verified' }
    rememberBounded(this.provenDescendants, id, MAX_PROVEN_DESCENDANTS)
    return null
  }

  /**
   * Note which of the ids on one event belong to a session outside the share.
   *
   * The owner's OTHER sessions in the same project appear on this stream —
   * opencode scopes /event by directory, not by session — so this is where a
   * relay would learn an id to name in a body (see foreignObjects). The same
   * position makes the answer cheap: the bridge reads the stream first.
   *
   * Best effort by construction, and the cheap path is the common one. Every
   * event names its session immediately after its type, so the share's own
   * events — nearly all of them, and the megabyte-long tool outputs among them
   * — are skipped on a substring scan, without parsing anything. An event this
   * misses costs a missed refusal, never a wrong one.
   */
  private noteForeignObjects(data: string): void {
    const bound = this.boundSessionId
    if (!bound) return
    const at = data.indexOf(EVENT_SESSION_KEY)
    if (at === -1) return
    const from = at + EVENT_SESSION_KEY.length
    const end = data.indexOf('"', from)
    if (end === -1) return
    const sessionID = data.slice(from, end)
    if (sessionID === bound || this.provenDescendants.has(sessionID)) return
    let properties: { sessionID?: unknown; info?: { id?: unknown }; part?: { id?: unknown; messageID?: unknown } }
    try {
      properties = (JSON.parse(data) as { properties?: typeof properties }).properties ?? {}
    } catch {
      return
    }
    // The scan found the event's own session, not one nested somewhere else.
    if (properties.sessionID !== sessionID) return
    for (const id of [properties.info?.id, properties.part?.id, properties.part?.messageID]) {
      if (typeof id !== 'string' || !OBJECT_ID_RE.test(id)) continue
      if (this.foreignObjects.delete(id)) {
        this.foreignObjects.set(id, sessionID)
        continue
      }
      while (this.foreignObjects.size >= MAX_FOREIGN_OBJECTS) {
        const oldest = this.foreignObjects.keys().next().value
        if (oldest === undefined) break
        this.foreignObjects.delete(oldest)
      }
      this.foreignObjects.set(id, sessionID)
    }
  }

  /**
   * Refuse a body that writes somewhere else.
   *
   * The path binding (guardSessionId) covers one of the two names a write
   * carries; this covers the other. An id the bridge has seen under a foreign
   * session is refused outright, and anything that is not an opencode id at
   * all — an object, a path, a 500-character string — never reaches a server
   * that interpolates it into storage keys.
   *
   * What it does NOT catch, said plainly: an id from a session whose events
   * this bridge never forwarded — one in another project, or one created while
   * an earlier bridge of this share was running. The write side upstream is
   * where that belongs; until opencode checks the id against the session in
   * the path, this closes the channel a relay actually has.
   */
  private guardBodyIds(body: unknown): GuardRefusal | null {
    for (const id of bodyObjectIds(body)) {
      if (typeof id !== 'string' || !OBJECT_ID_RE.test(id)) return { status: 403, error: 'malformed id in request body' }
      const owner = this.foreignObjects.get(id)
      if (owner !== undefined && !this.provenDescendants.has(owner)) {
        return { status: 403, error: 'request body names another session' }
      }
    }
    return null
  }

  /**
   * The query a request is forwarded with: the SHARE's project, and nothing
   * the relay can re-target it with.
   *
   * The relay pins ?directory=… to the session's own directory, and the bridge
   * used to take that on trust — so a relay that named another directory (or
   * added `workspace`/`scope`, which take routing PRECEDENCE in opencode, or
   * another spelling of the same key) moved the request to another project of
   * the owner's, with their credentials. Mirrors the relay's queryForSession:
   * both directory spellings forced, every other directory/location/workspace/
   * scope key dropped, pagination and the rest untouched.
   */
  private pinnedQuery(query: string): string {
    const params = new URLSearchParams(query)
    const directory = this.sessionDirectory
    if (directory !== undefined) {
      params.set('directory', directory)
      params.set('location[directory]', directory)
    }
    // With no directory of our own to pin, the relay's single `directory` is
    // still the best instance we know of; the re-targeting keys never are.
    const forced = new Set(directory === undefined ? ['directory'] : ['directory', 'location[directory]'])
    for (const key of new Set(params.keys())) {
      if (forced.has(key)) continue
      const lower = key.toLowerCase()
      if (
        lower.startsWith('directory') ||
        lower.startsWith('location') ||
        lower.startsWith('workspace') ||
        lower.startsWith('scope')
      ) {
        params.delete(key)
      }
    }
    const qs = params.toString()
    return qs ? `?${qs}` : ''
  }

  /**
   * Answer or dismiss only a question of the bound session or its subagents.
   *
   * opencode's POST /question/:requestID/reply and /reject take nothing but
   * the id and act on whichever pending question has it, from any session —
   * so without this a viewer, or a hostile relay, could answer or dismiss a
   * question the agent put to the owner in another session. The pending list
   * is read with the forwarded request's own query: questions are held per
   * instance (the ?directory=… the relay pins), and that is the instance the
   * reply will act on. Anything that does not prove ownership is refused.
   */
  private async guardQuestion(requestID: string, path: string): Promise<GuardRefusal | null> {
    const notFound: GuardRefusal = { status: 403, error: 'question request not found for this session' }
    if (!this.boundSessionId) return { status: 403, error: 'question verification unavailable' }
    const query = queryOfPath(path)
    try {
      const pending: unknown = await this.opencode.listQuestions(query)
      if (!Array.isArray(pending)) return notFound
      for (const q of pending) {
        const rec = q as Record<string, unknown> | null
        if (rec?.id !== requestID) continue
        if (await this.sharesTree(rec.sessionID, query)) return null
      }
      return notFound
    } catch {
      // If we cannot verify, fail closed.
      return { status: 403, error: 'question verification unavailable' }
    }
  }

  /**
   * Whether a pending request of `sessionID` belongs to the share: the bound
   * session itself, or a subagent of it at any depth.
   *
   * The task tool runs a subagent in a child session (parentID = the session
   * that started it), and the permission or question the subagent needs
   * carries the CHILD's id — measured on opencode 1.18.30. While it is pending
   * the parent waits on it, so refusing it (as the guards did when they
   * compared with the bound id alone) left a viewer-driven share blocked until
   * the owner answered locally.
   *
   * Proven by walking parentID through the local opencode, in the forwarded
   * request's own instance, up to the bound session. Anything that does not
   * prove it is not: a detail that cannot be read or does not echo its own id,
   * a root that is not ours, a loop, or a chain deeper than any real nesting.
   */
  private async sharesTree(sessionID: unknown, query: string): Promise<boolean | undefined> {
    const bound = this.boundSessionId
    if (!bound || typeof sessionID !== 'string') return false
    if (sessionID === bound) return true
    if (this.provenDescendants.has(sessionID)) return true
    const seen = new Set<string>()
    let current = sessionID
    for (let hop = 0; hop < MAX_SUBAGENT_DEPTH; hop++) {
      if (!SESSION_ID_RE.test(current) || seen.has(current)) return false
      seen.add(current)
      let detail: { id?: unknown; parentID?: unknown } | null
      try {
        detail = (await this.opencode.getSession(current, query)) as typeof detail
      } catch (err) {
        // A session opencode says it does not have is ruled out; a lookup it
        // could not answer at all proves nothing either way, and the caller
        // has to be able to tell those apart (see guardSessionId).
        return (err as { status?: unknown }).status === 404 ? false : undefined
      }
      if (detail?.id !== current || typeof detail.parentID !== 'string') return false
      if (detail.parentID === bound || this.provenDescendants.has(detail.parentID)) {
        // Every session on a chain that reaches the share is one too.
        for (const id of seen) rememberBounded(this.provenDescendants, id, MAX_PROVEN_DESCENDANTS)
        return true
      }
      current = detail.parentID
    }
    return false
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
  waitForRoom: () => Promise<void> = async () => {},
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      await waitForRoom()
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
