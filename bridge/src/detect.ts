import { exec } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { config, opencodeAuthHeader, sessionProbeTimeoutMs } from './config.js'

const execP = promisify(exec)

/** A TCP listener owned by a node/opencode process. */
export interface Listener {
  port: number
  pid: number
}

/**
 * TCP listeners of node/opencode processes (case-insensitive — the desktop app
 * reports its command as "OpenCode"), with the pid that owns each. lsof prints
 * the address as `127.0.0.1:4096`, `*:4096` or `[::1]:4096`, so the port is
 * read after the LAST colon — splitting on the first one dropped every IPv6
 * listener.
 */
export async function listListeners(): Promise<Listener[]> {
  const { stdout } = await execP(
    "lsof -iTCP -sTCP:LISTEN -P 2>/dev/null | awk 'tolower($1) ~ /opencode|node/ {print $2, $9}'",
  )
  const listeners: Listener[] = []
  for (const line of stdout.split('\n')) {
    const [pidField, address] = line.trim().split(/\s+/)
    if (!pidField || !address) continue
    const pid = Number(pidField)
    const port = Number(address.slice(address.lastIndexOf(':') + 1))
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port) || port <= 0) continue
    // IPv4 and IPv6 sockets of one server are two lines for the same pair.
    if (!listeners.some((l) => l.port === port && l.pid === pid)) listeners.push({ port, pid })
  }
  return listeners
}

/** TCP ports listened on by node/opencode processes, each once. */
export async function listCandidatePorts(): Promise<number[]> {
  return [...new Set((await listListeners()).map((l) => l.port))]
}

/**
 * Report which port a local OpenCode server is on: the first candidate whose
 * /global/health answers { healthy: true } for the env credentials.
 * `candidates` is a test hook — production callers scan the machine.
 *
 * This answers "is an opencode running", nothing more, and only `status` asks
 * it. What a SHARE runs on is decided by ensureOpenCodeServer, which also
 * requires the candidate to hold the session being shared: health alone is
 * answered by anything on the machine that cares to (see SessionRequirement).
 *
 * `acceptGuarded` also takes a server that demands credentials this process
 * does not hold. Only `status` wants that: a server a running share spawned
 * carries a password only that share's bridge knows (see
 * ensureOpenCodeServer), so the credentialed probe cannot see it, and the
 * command would report the owner's working opencode as "not detected".
 * Anything that goes on to USE the port must leave it off.
 */
export async function detectOpenCodePort(
  candidates?: number[],
  { acceptGuarded = false }: { acceptGuarded?: boolean } = {},
): Promise<number> {
  for (const port of candidates ?? (await listCandidatePorts())) {
    const health = await probeHealth(port, opencodeAuthHeader())
    if (health === 'healthy' || (acceptGuarded && health === 'guarded')) return port
  }
  throw new Error('opencode not found')
}

/**
 * What a listening server must hold before a share is allowed to run on it.
 *
 * Health used to be the whole test, and /global/health is one route any
 * process of this user can answer: a leftover stub, a dev server, a dependency
 * that started one, or something put there on purpose. The first such listener
 * — lowest pid, so usually the oldest — became the upstream of the share,
 * saw every proxied request (prompts included), decided every answer the
 * viewer got, and was handed the bridge's Authorization header, which is the
 * owner's OPENCODE_SERVER_PASSWORD and opens their real opencode. Measured in
 * production: two stub servers from an earlier test took two shares in a row,
 * each of which registered, reported "bridge: connected", and answered every
 * viewer 401.
 *
 * So a candidate is asked for the one thing a stranger cannot have: the
 * session this share is about to serve.
 */
export interface SessionRequirement {
  /**
   * The session the share serves, when the start already knows which (the
   * plugin passes the session the command was typed in; `--session-id` does
   * the same). The candidate must answer for it.
   */
  sessionId?: string
  /**
   * The project directory the share is for — the start's cwd. When no session
   * is known yet the candidate must hold at least one session there, which is
   * what the start goes on to pick from, so the server it picks from is the
   * server it runs on.
   */
  directory?: string
}

export interface EnsureServerOptions {
  /**
   * What a candidate must serve before this share runs on it. `{}` requires
   * nothing beyond health — for callers that have already decided which server
   * they mean (tests of the health and ownership layers); a share always names
   * its session, its directory, or both.
   */
  serves: SessionRequirement
  /** Listening node/opencode processes — test hook; defaults to listListeners(). */
  listListeners?: () => Promise<Listener[]>
  /**
   * Whether the process behind a listener belongs to a share on this machine:
   * spawned by a bridge that is still running, or recorded by a share as the
   * server it spawned. Such a server is never attached to.
   */
  ownedByShare?: (pid: number) => boolean
}

/**
 * Find the server this share may run on — one that is alive, is not another
 * share's, and holds the session being shared (see SessionRequirement) — or
 * spawn `opencode serve` when no listener qualifies (plain `opencode run`/
 * `--mini` use an in-process server with no external HTTP port, so there is
 * often nothing to find). Returns the port and, if we spawned it, the child
 * process so the caller can tie its lifetime to the bridge.
 */
export async function ensureOpenCodeServer(
  opts: EnsureServerOptions,
): Promise<{ port: number; spawned?: import('node:child_process').ChildProcess; password?: string }> {
  let listeners: Listener[] = []
  try {
    listeners = await (opts.listListeners ?? listListeners)()
  } catch {
    // No lsof (or no awk): nothing to attach to — start our own below.
  }
  for (const { port, pid } of listeners) {
    // Which credentials, if any, open this listener — and none of the owner's
    // handed to it before it is known to want them (see credentialsFor).
    const credentials = await credentialsFor(port)
    if (credentials === undefined) continue
    // A server another share spawned is not the user's: its lifetime belongs to
    // that share, which kills it on every way it ends (stop, the relay revoking
    // it, a signal, its bridge exiting). Attaching to it made this share run on
    // borrowed time — ending the first share cut the second one's viewers off
    // and then ended it too. Start a server of our own instead. The same goes
    // for a server a share whose bridge died left behind: `stop` of that share
    // ends it.
    if (opts.ownedByShare?.(pid)) {
      console.warn(
        `bridge: not attaching to the opencode server on port ${port} (pid ${pid}) — another share started it and ends it with that share; starting a separate one`,
      )
      continue
    }
    // Health says something is alive on that port, not that it is the owner's
    // opencode — anything answering one route passes it. This is the test that
    // a stranger cannot pass: the session this share is about to serve.
    if (!(await holdsSession(port, opts.serves, credentials))) {
      console.warn(
        `bridge: passing over the server on port ${port} (pid ${pid}) — it answers the health route but ${describeMissing(opts.serves)}, ` +
          'and a share can only run on the server that has it. ' +
          `If this IS your opencode, share again with OPENCODE_REMOTE_CONTROL_PORT=${port}`,
      )
      continue
    }
    // The owner's own server, with its own credentials policy — which may be
    // no policy at all. An `opencode serve` without a password authenticates
    // nothing and answers any loopback page (see newServerPassword), so say so
    // once: this share cannot fix it, and the owner is the only one who can.
    if (credentials.authorization === undefined) {
      console.warn(
        `bridge: the opencode server on port ${port} (pid ${pid}) answers requests without a password — any web page you open can drive it; ` +
          `set OPENCODE_SERVER_PASSWORD before starting it, or let the bridge start its own server`,
      )
    }
    return { port }
  }
  // No running server we may use — start a headless one bound to the current project.
  const { spawn } = await import('node:child_process')
  // Ours to start, so ours to lock: a password no one else on this machine has.
  const password = newServerPassword()
  // Capture the server's own logs instead of inheriting our stderr: the TUI
  // plugin reads the bridge's output to show the share URL + code, and the
  // opencode server writes a screenful of INFO/WARN lines that used to bury
  // it (and made every line matching /error/ look like a bridge failure).
  // The tail is kept only to explain a startup failure.
  const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1'], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverLogTail = ''
  const keepTail = (chunk: Buffer) => {
    serverLogTail = (serverLogTail + chunk.toString()).slice(-SERVER_LOG_TAIL_CHARS)
  }
  child.stderr?.on('data', keepTail)
  // The tail explains a failed start; the password in it explains nothing. A
  // server that logs its own config puts it there, and from here it goes to the
  // owner's screen and into bridge.log. Redacted once, on the joined tail, so a
  // password split across two chunks is caught too.
  const failure = (message: string) =>
    new Error(serverLogTail ? `${message}\n${serverLogTail.split(password).join('<redacted>').trim()}` : message)
  const port = await new Promise<number>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); reject(failure('opencode serve did not report a port in time')) }
    }, 20_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      keepTail(chunk)
      const m = /http:\/\/[^:\s]+:(\d+)/.exec(chunk.toString())
      if (m && !settled) {
        settled = true
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
    child.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err) } })
    child.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); reject(failure(`opencode serve exited early (${code})`)) } })
  })
  // Wait until it actually answers before returning — with the password we gave
  // it, so a server that ignored it is never taken for a working one.
  for (let i = 0; i < 20; i++) {
    if (await isHealthy(port, password)) return { port, spawned: child, password }
    await new Promise((r) => setTimeout(r, 250))
  }
  child.kill()
  throw new Error('opencode serve started but never became healthy')
}

/** How much of the spawned server's log to keep for failure messages. */
const SERVER_LOG_TAIL_CHARS = 4000

/**
 * The password for a server the bridge starts.
 *
 * `opencode serve` with an empty OPENCODE_SERVER_PASSWORD checks neither
 * Authorization nor Host and reflects CORS back at any loopback origin
 * (measured on opencode 1.18.31), so an unsecured one is a session-creating,
 * shell-running API for any page the owner happens to open — no access code,
 * no relay, nothing this project's model covers. The server is the bridge's
 * own, so its credentials can be too: 192 random bits, held in this process
 * and the child's environment only, gone when the share ends.
 */
function newServerPassword(): string {
  return randomBytes(24).toString('base64url')
}

async function isHealthy(port: number, password?: string): Promise<boolean> {
  return (await probeHealth(port, opencodeAuthHeader(password))) === 'healthy'
}

/** What a probe of a candidate carries: an Authorization header, or nothing at all. */
interface Credentials {
  /** The header value; absent for a server that answers without one. */
  authorization?: string
}

/**
 * Which credentials open a candidate's health route: none for a server that
 * answers anybody, the environment's for one that asks and accepts them, and
 * undefined for anything else — a stale listener, an unrelated process, a
 * server whose password this process does not hold.
 *
 * Asked WITHOUT credentials first, and that order is the point. The owner's
 * OPENCODE_SERVER_PASSWORD opens their real opencode, which creates sessions
 * and runs shell commands; the probe used to put it on every listening port on
 * the machine before knowing what was there, so a stranger that merely logged
 * what it received was handed it (the production incident's stub was exactly
 * that shape). A server that answers anybody never sees it now. One that
 * demands credentials still does — telling the owner's guarded server from a
 * stranger's 401 needs them — which is why the session test below matters even
 * more for that half.
 */
async function credentialsFor(port: number): Promise<Credentials | undefined> {
  if ((await probeHealth(port, undefined)) === 'healthy') return {}
  const authorization = opencodeAuthHeader()
  return (await probeHealth(port, authorization)) === 'healthy' ? { authorization } : undefined
}

/**
 * What a candidate port answers on the health route: 'healthy' for an opencode
 * these credentials open, 'guarded' for one that wants credentials we do not
 * have (someone else's server, or a server another share spawned), 'no' for
 * anything else — a stale listener, an unrelated process, an unreachable port.
 *
 * `authorization` is the header to send, or undefined to send none.
 */
async function probeHealth(port: number, authorization: string | undefined): Promise<'healthy' | 'guarded' | 'no'> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${config.healthPath}`, {
      headers: authorization === undefined ? {} : { Authorization: authorization },
      signal: AbortSignal.timeout(config.healthTimeoutMs),
    })
    if (res.status === 401 || res.status === 403) return 'guarded'
    const data = (await res.json()) as { healthy?: unknown }
    return data.healthy === true ? 'healthy' : 'no'
  } catch {
    return 'no'
  }
}

/**
 * Whether the server on `port` holds what this share needs: the session it is
 * about to share, or — when the start has not picked one yet — a session in
 * the directory it will pick from, so that the server it picks from is the
 * server it runs on.
 *
 * Anything short of a clear yes is a no: a 404, an error, an answer that is
 * not that session, or no answer inside the deadline. Fail-closed on purpose.
 * Being wrong here costs an `opencode serve` of our own — which is what every
 * TUI share does anyway — while the opposite mistake is the owner's prompts
 * going to a stranger.
 *
 * Asked with the credentials that opened the health route and no others: a
 * candidate that answers anybody on health and then demands a password for the
 * session is not a shape opencode has (1.18.31 guards every route or none),
 * and treating it as one would be a second way to bait the owner's password
 * out of the bridge.
 */
async function holdsSession(port: number, want: SessionRequirement, credentials: Credentials): Promise<boolean> {
  if (want.sessionId !== undefined) {
    const detail = `/session/${encodeURIComponent(want.sessionId)}`
    // Without a directory first, the way the bridge asks for the session's own
    // detail once the share is up: opencode answers for a session of any
    // project it knows (measured on 1.18.31). The scoped question is the
    // fallback for a server that answers only for one project.
    const asks =
      want.directory === undefined ? [detail] : [detail, `${detail}?directory=${encodeURIComponent(want.directory)}`]
    for (const ask of asks) {
      const session = await askOpencode(port, ask, credentials)
      if (isRecord(session) && session.id === want.sessionId) return true
    }
    return false
  }
  // Nothing named at all: the caller has already decided which server it means.
  if (want.directory === undefined) return true
  const sessions = await askOpencode(port, `/session?directory=${encodeURIComponent(want.directory)}`, credentials)
  return Array.isArray(sessions) && sessions.some((s) => isRecord(s) && typeof s.id === 'string' && s.id !== '')
}

/** Why a candidate was passed over, for the owner reading the log. */
function describeMissing(want: SessionRequirement): string {
  if (want.sessionId !== undefined) return `does not have session ${want.sessionId}`
  if (want.directory !== undefined) return `has no session in ${want.directory}`
  return 'is not usable'
}

/** One GET at a candidate, parsed; undefined for anything but a 2xx with JSON. */
async function askOpencode(port: number, path: string, credentials: Credentials): Promise<unknown> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: credentials.authorization === undefined ? {} : { Authorization: credentials.authorization },
      signal: AbortSignal.timeout(sessionProbeTimeoutMs()),
    })
    if (!res.ok) return undefined
    return await res.json()
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
