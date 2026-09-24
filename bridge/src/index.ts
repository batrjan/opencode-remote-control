#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Command } from 'commander'
import {
  config,
  namedOpencodePort,
  opencodeAuthHeader,
  relayDeleteTimeoutMs,
  watchdogIntervalMs,
  watchdogProbeTimeoutMs,
  watchdogStrikes,
} from './config.js'
import { detectOpenCodePort, ensureOpenCodeServer, listListeners, type Listener } from './detect.js'
import { describeError, originOf } from './errors.js'
import { OpencodeClient } from './opencode.js'
import { RelayClient, RelayHttpError, RelayWSClient, type RelaySession, type SessionStatus } from './relay.js'
import {
  saveSessionState,
  loadSessionState,
  clearSessionState,
  clearOwnSessionState,
  markOwnSessionBridgeGone,
  latestSessionState,
  listSessionStates,
  ownerKey,
  type SessionState,
} from './state.js'

/**
 * Bridge CLI and lifecycle: `start` registers the current opencode session
 * with the relay, connects the WS bridge, forwards SSE events, and watches
 * the local opencode server and, with --owner-pid, the OpenCode process that
 * started the share (exits when either is gone); `stop` deletes the relay
 * session; `status` probes relay + opencode + session presence.
 *
 * The module doubles as a library (startBridge/stopBridge) for tests; the
 * commander program only runs when the file is executed directly.
 */

export interface StartBridgeOptions {
  /** Explicit opencode port; auto-detected when omitted. */
  port?: number
  /** Explicit session id; the newest session (preferring cwd) when omitted. */
  sessionId?: string
  /** Full opencode base URL — test hook that overrides port detection. */
  opencodeUrl?: string
  /** Watchdog poll interval — test hook; defaults to watchdogIntervalMs(). */
  healthIntervalMs?: number
  /** Server spawner — test hook; defaults to ensureOpenCodeServer(), skipping servers other shares spawned. */
  serverSpawner?: () => Promise<{
    port: number
    spawned?: import('node:child_process').ChildProcess
    /** Credential of a server the spawner started; the environment's otherwise. */
    password?: string
  }>
  /**
   * PID of the OpenCode process the share was started from (the plugin passes
   * its own). The bridge shuts down once that process is gone. Omitted for a
   * bridge started by hand, which then lives until stopped or opencode dies.
   */
  ownerPid?: number
}

export interface BridgeHandle {
  session_id: string
  access_code: string
  viewer_url: string
  /**
   * Resolves once the bridge has fully shut down, with why when it ended on its
   * own (watchdog, relay) and undefined when stop() was called.
   */
  closed: Promise<string | undefined>
  /** Stop the watchdog, close the WS, and delete the relay session. Idempotent. */
  stop(): Promise<void>
}

interface OpencodeSessionInfo {
  id: string
  directory?: string
  title?: string
  parentID?: string
  time?: { created?: number }
}

export async function startBridge(
  relayUrl: string,
  apiKey: string | undefined,
  opts: StartBridgeOptions = {},
): Promise<BridgeHandle> {
  const relay = new RelayClient(relayUrl, apiKey)
  // The port the owner named: `--port`, or OPENCODE_REMOTE_CONTROL_PORT for a
  // path with no flags to pass (the plugin runs `start` itself). Either way it
  // is the owner saying which server is theirs, so it is used as given —
  // detection, and the session test that goes with it, are skipped.
  const namedPort = opts.port ?? namedOpencodePort()
  // A server this start names itself (--port, the environment, a URL) may be
  // exactly the `opencode serve` an earlier, dead share of the session left
  // behind, so that leftover is ended only once it is known to listen on
  // another port (see LeftoverServerPolicy). Ending it regardless left the
  // start nothing to run on; keeping it regardless, when the named server was
  // the owner's own, lost the only record of the leftover and left it running
  // unsecured for good.
  const namedServer: LeftoverServerPolicy | undefined = opts.opencodeUrl
    ? { namedPort: urlPort(opts.opencodeUrl) }
    : namedPort !== undefined
      ? { namedPort }
      : undefined
  // The state of a dead share whose `opencode serve` settling it kept running
  // (see settleEarlierShare). That state was the only record of the server, and
  // dropping it with nothing in its place left the server running unsecured for
  // good — right away when the named server was the owner's own and lsof could
  // not tell, or once this share stopped when it ran on that very server — and
  // the next detection took it for the owner's. So this share takes it over:
  // records it as its own server, ends it when it ends, and a start that fails
  // puts the dead share's record back.
  let keptServerOf: SessionState | undefined
  const keepServer = (earlier: SessionState) => {
    keptServerOf = earlier
  }
  // An earlier share of this session recorded on this machine is settled
  // before any server is detected or spawned: a live one is refused without
  // anything being started, and the `opencode serve` a dead one left behind
  // has to be gone before detection could mistake it for the user's own.
  if (opts.sessionId !== undefined) {
    // Taking it back where this start can (see settleEarlierShare): the
    // registration registerShare makes below then presents the code recorded
    // for it, and the relay continues that share rather than replacing it.
    await settleEarlierShare(relay, opts.sessionId, namedServer ?? true, keepServer, true)
  }
  // When no opencode server is listening (plain console runs use an
  // in-process server with no HTTP port), spawn `opencode serve` ourselves so
  // remote control works without the TUI. The spawned server is tied to the
  // bridge's lifetime below.
  let spawnedServer: import('node:child_process').ChildProcess | undefined
  let resolvedPort: number
  // A server the bridge starts gets a password of its own (see
  // ensureOpenCodeServer) that is deliberately not in the environment, so
  // everything that talks to opencode from here on carries THIS, not the env.
  let opencodePassword = process.env.OPENCODE_SERVER_PASSWORD ?? ''
  // Whether the server this start runs on cannot be the `opencode serve` an
  // earlier, dead share of the session left behind, so settling that share may
  // end it (see registerShare). A server named by --port or a URL may be exactly
  // that leftover, which is then decided by the port it listens on; one we
  // spawned cannot, nor one detection picked, since it never attaches to a
  // server a share recorded (spawnedByRecordedShare).
  let endLeftoverServer: LeftoverServerPolicy = namedServer ?? false
  if (opts.opencodeUrl) {
    resolvedPort = 0 // unused; url given directly
  } else if (namedPort !== undefined) {
    resolvedPort = namedPort
  } else {
    // Never attach to a server another share on this machine spawned: that
    // share kills it when it ends, and this one would go down with it. That
    // includes the server of a share whose bridge was killed with -9: it is
    // re-parented away, so only the share's state file still names it. Without
    // a session id this start learns which share it takes back only after
    // detection, and used to attach to such a leftover as if it were the
    // owner's own server: settling the dead share then dropped the only record
    // of the server and left it running for good, and a share of another
    // session ran on a server that a `stop` of the stale one would kill.
    // Nor to a server that does not have the session this share is about to
    // serve. Health alone is one route any process of this user can answer, so
    // it took only a leftover stub on a lower pid for the owner's share to be
    // proxied to a stranger — which then saw every prompt and decided every
    // answer the viewer got (see SessionRequirement).
    const ensured = await (
      opts.serverSpawner ??
      (() =>
        ensureOpenCodeServer({
          serves: { sessionId: opts.sessionId, directory: process.cwd() },
          ownedByShare: (pid) => belongsToRunningShare(pid) || spawnedByRecordedShare(pid),
        }))
    )()
    resolvedPort = ensured.port
    spawnedServer = ensured.spawned
    opencodePassword = ensured.password ?? opencodePassword
    // A test hook's server is vetted by nobody, unless it was spawned for us.
    endLeftoverServer = spawnedServer !== undefined || opts.serverSpawner === undefined
  }
  const killSpawnedServer = () => {
    if (spawnedServer && spawnedServer.exitCode === null && !spawnedServer.killed) spawnedServer.kill()
  }
  // Last resort: never leave the spawned server behind if this process dies
  // for a reason that does not go through stop(). Armed as soon as the server
  // exists, not once the share is up — everything below can still fail.
  process.on('exit', killSpawnedServer)
  const opencodeUrl = opts.opencodeUrl ?? `http://127.0.0.1:${resolvedPort}`
  const opencode = new OpencodeClient(opencodeUrl, process.env.OPENCODE_SERVER_USERNAME ?? 'opencode', opencodePassword)
  let session_id: string
  let access_code: string
  let bridge_token: string
  let viewer_url: string
  /** Whether the relay CONTINUED a share that was already running (see registerShare). */
  let resumed = false
  let ws: RelayWSClient
  try {
    // With an explicit --session-id we still need the session's OWN directory:
    // it is what the relay pins every proxied request to and what scopes the
    // event stream. Falling back to process.cwd() pointed both at whatever
    // folder the bridge happened to start in.
    const picked =
      opts.sessionId === undefined ? await pickSession(opencode) : await fetchSession(opencode, opts.sessionId)
    session_id = opts.sessionId ?? picked!.id
    // A leftover server of an earlier share is only ended here when it cannot
    // be the server this start runs on (see endLeftoverServer above).
    ;({ access_code, bridge_token, viewer_url, resumed } = await registerShare(
      relay,
      session_id,
      picked?.directory ?? process.cwd(),
      picked?.title ?? '',
      endLeftoverServer,
      // An explicit id was settled above, before anything was spawned.
      opts.sessionId === undefined,
      keepServer,
    ))
    // Persist the owner token so `stop` (even from another shell) can delete
    // the session later. 0600 perms; cleared on stop.
    // The pid lets `stop` (run from the TUI plugin or another shell) terminate
    // this long-running process — deleting the relay session alone left the
    // bridge and the `opencode serve` it spawned running forever.
    saveSessionState({
      session_id,
      access_code,
      bridge_token,
      relay: relayUrl,
      started_at: Date.now(),
      pid: process.pid,
      // Only when WE spawned it, or took it over from a dead share of this
      // session that spawned it (keptServerOf): a server that was already
      // listening belongs to the user (their GUI, their own `opencode serve`)
      // and must never be killed by `stop`.
      server_pid: spawnedServer?.pid ?? keptServerOf?.server_pid,
    })
    ws = new RelayWSClient(relayUrl, opencode)
    try {
      await ws.connect(session_id, bridge_token, picked?.directory)
      await ws.startEventForwarding()
    } catch (err) {
      ws.close()
      // Never leave an orphaned session behind when the WS/SSE setup fails —
      // unless the registration CONTINUED a share that was already up, with
      // viewers in it. Deleting that is the one thing this whole path exists
      // to avoid: those viewers were watching a second ago, the code they
      // would need again is on the machine that just failed, and what failed
      // is the bridge's own dial, not their share. It is left registered
      // instead, so the retry the owner is about to make resumes it once more;
      // the state file goes on naming its live bridge_token, so `stop` still
      // ends it outright; and the relay's own unbound reaper takes it minutes
      // from now if nobody comes back for it (config.unboundReapMs).
      if (resumed) {
        // This process is on its way out and never had a bridge: say so on the
        // state, or the next start would read a pid that is ours and still
        // alive (a caller embedding the library) and refuse the share as one
        // this machine is already sharing.
        markOwnSessionBridgeGone(session_id, bridge_token)
      } else {
        await relay.deleteSession(session_id, bridge_token).catch(() => {})
        // Only our own state, as in stop() below. A concurrent start of this
        // session that registered after us replaced our registration (the relay
        // then refuses our bridge with 401) and has written ITS state under the
        // same name by now.
        clearOwnSessionState(session_id, bridge_token)
      }
      throw err
    }
  } catch (err) {
    // A start that fails after spawning `opencode serve` (relay unreachable,
    // 429/409 on registration, no session to pick, bridge WebSocket refused)
    // must take that server down with it. Left running, it was an orphan no
    // `stop` could find (no state file), its stdout/stderr pipes kept this
    // process's event loop alive so the failed CLI hung instead of exiting, and
    // the next `start` attached to it as if it were the user's own server —
    // without a server_pid, so nothing ever killed it.
    process.off('exit', killSpawnedServer)
    killSpawnedServer()
    // A server kept from a dead share is not ended: it may be the one the owner
    // named, and a retry on it would find nothing. Its record goes back instead
    // (the relay registration it held is ended already), unless a share wrote
    // one of its own meanwhile, so `stop` or the next start still settles it.
    if (keptServerOf && loadSessionState(keptServerOf.session_id) === undefined) saveSessionState(keptServerOf)
    throw err
  }

  let resolveClosed!: (reason: string | undefined) => void
  const closed = new Promise<string | undefined>((resolve) => {
    resolveClosed = resolve
  })
  let stopped = false
  // `reason` says why the share ended when nobody asked it to. Every exit path
  // (watchdog, relay, signal) runs this same teardown, and the owner used to
  // get a bare "Remote control stopped." for all of them — on the plugin path
  // only in its private log — with nothing telling a dead server from a signal.
  const stop = async (reason?: string) => {
    if (stopped) return
    stopped = true
    clearInterval(watchdog)
    process.off('exit', killSpawnedServer)
    ws.close()
    // If we spawned the opencode server ourselves (the TUI has no HTTP port,
    // so this is the normal path), stop it too — the share's lifetime owns
    // the server it created. So does it own one it took over from a dead share.
    killSpawnedServer()
    if (keptServerOf) terminateSpawnedServer(keptServerOf.server_pid, keptServerOf.started_at)
    try {
      await relay.deleteSession(session_id, bridge_token)
    } catch {
      // Best effort: the relay may itself be unreachable at shutdown. The
      // DELETE is time-bounded, so a relay that never answers cannot keep a
      // SIGTERM'd bridge alive after its share is already down (ws closed above).
    }
    // Only our own state. A later start of this session from this install
    // replaces our registration on the relay (which is how we got here, with a
    // 4001) and has already written ITS state under the same name: removing
    // that would leave the live share without the token `stop` needs.
    clearOwnSessionState(session_id, bridge_token)
    resolveClosed(reason)
  }
  // The relay only closes us on purpose when the session is gone (stopped
  // elsewhere, or credentials revoked) — there is nothing left to reconnect
  // to, so shut down instead of retrying forever.
  ws.onFatal = (err) => void stop(`the relay ended the session (${err.message})`)
  // The share belongs to the OpenCode process it was started from, not to the
  // server we talk to. On the TUI path that server is our own `opencode serve`,
  // and the plugin starts us detached, so quitting the TUI signalled neither:
  // bridge and server kept each other alive, the relay kept seeing pings, and
  // the code and every viewer token stayed valid indefinitely. While the owner
  // is our parent, a changed ppid (re-parented to init or a subreaper) is proof
  // it is gone that a recycled pid cannot fake; otherwise (a `node` shim in
  // between, Windows, where ppid never changes) fall back to asking the OS
  // whether the pid still exists.
  const ownerPid = opts.ownerPid
  const ownerIsParent = ownerPid !== undefined && ownerPid === process.ppid
  const ownerGone = (): boolean => {
    if (ownerPid === undefined) return false
    if (ownerIsParent && process.ppid !== ownerPid) return true
    return !pidAlive(ownerPid)
  }
  // Watchdog: owner gone, or opencode gone (process exited / port closed) →
  // notify the relay (revokes code + tokens) and shut down.
  //
  // The owner check is exact, so it acts at once. A failed health probe is not:
  // a timeout only says the server did not answer in time, and the stop it
  // triggers is drastic — the code and every viewer token revoked, and on the
  // TUI path the `opencode serve` holding the viewers' running work killed. So
  // it takes several failed probes in a row, like the relay link's keep-alive
  // takes several silent ticks; a server that is really gone keeps failing and
  // is still caught. Probes never overlap: one that is still waiting for its
  // answer is not a second failure.
  const strikes = watchdogStrikes()
  let probing = false
  let failedProbes = 0
  const watchdog = setInterval(() => {
    if (stopped) return
    if (ownerGone()) {
      void stop(`the OpenCode process that started the share (pid ${ownerPid}) exited`)
      return
    }
    if (probing) return
    probing = true
    void (async () => {
      try {
        const failure = await probeOpencode(opencodeUrl, opencodePassword)
        if (stopped) return
        if (failure === undefined) {
          if (failedProbes > 0) {
            console.warn(
              `bridge: local opencode at ${opencodeUrl} is answering again after ${failedProbes} failed health probe(s)`,
            )
          }
          failedProbes = 0
          return
        }
        failedProbes++
        if (failedProbes < strikes) {
          console.warn(
            `bridge: local opencode at ${opencodeUrl} failed health probe ${failedProbes} of ${strikes} (${failure})`,
          )
          return
        }
        console.warn(
          `bridge: local opencode at ${opencodeUrl} failed ${failedProbes} health probes in a row (${failure}) — ending the share`,
        )
        await stop(
          `the local opencode server stopped responding (${failedProbes} health probes in a row failed: ${failure})`,
        )
      } finally {
        probing = false
      }
    })()
  }, opts.healthIntervalMs ?? watchdogIntervalMs())
  watchdog.unref() // never keep the process alive just for the watchdog

  return { session_id, access_code, viewer_url, closed, stop: () => stop() }
}

/**
 * Register the share, and when the relay already holds the session id (409),
 * find out whose registration that is before giving up.
 *
 * The share link names the session id, and a relay that hands a freed id to
 * whoever registers it first let anyone holding an old link take it the moment
 * the owner stopped. Every registration therefore carries this install's
 * owner_key (see state.ts ownerKey): the relay keeps an ended share's id
 * reserved for it, and lets the same key replace its own registration, so a
 * restart after a bridge died without a word (SIGKILL, a crash, a reboot) no
 * longer waits a day even without the state file that held its token.
 *
 * That replacement is also why a share this machine still runs has to be
 * found before registering, not on a 409: the relay would take it over under
 * its viewers. With `settleFirst` the earlier share recorded here is settled
 * first — still running is refused with its pid and how to end it, dead is
 * taken back where this start can take it back and ended with its own token
 * where it cannot. A 409 settles it the second way and registers again, once:
 * a relay that predates owner keys refuses the same install like anyone else,
 * as does a registration an older bridge made without a key.
 *
 * Taking it back rather than ending it is what keeps the viewers in. The dead
 * share's state file is left where it is, so the code in it can be presented
 * with this registration (resumableCode) and the relay continues that share
 * instead of replacing it: the code the owner already handed out goes on
 * working, and every tab holding a viewer token stays in. Ending the share
 * first — which is what a settle used to do unconditionally — revoked both
 * before the relay was ever asked, and no amount of care further on could
 * bring them back.
 */
async function registerShare(
  relay: RelayClient,
  sessionId: string,
  directory: string,
  title: string,
  endLeftoverServer: LeftoverServerPolicy,
  settleFirst: boolean,
  keepServer: (earlier: SessionState) => void,
): Promise<RelaySession & { resumed: boolean }> {
  const isConflict = (err: unknown): err is RelayHttpError => err instanceof RelayHttpError && err.status === 409
  // Bound to this relay: the key is sent in the clear, and must prove nothing
  // on any other one (see ownerKey).
  const key = ownerKey(relay.url, sessionId)
  if (settleFirst) await settleEarlierShare(relay, sessionId, endLeftoverServer, keepServer, true)
  let conflict: RelayHttpError
  try {
    // Read here rather than carried from the settle, because the settle is the
    // thing that decides it: a share it ENDED has its state file dropped, so
    // there is no code to present and none is — which is exactly right, since
    // the share that code belonged to is gone.
    const code = resumableCode(sessionId, relay)
    const session = await relay.createSession(sessionId, directory, title, key, code)
    // The relay says whether it continued the share by answering with the code
    // it was given: it holds only a salted hash of the code, so a code that
    // comes back is one it recognised, and a relay too old to know the field
    // answers with a new one. Nothing else has to be believed about it.
    const resumed = code !== undefined && session.access_code === code
    if (resumed) {
      console.warn(
        `bridge: the relay kept the share of session ${sessionId} running — its access code still works, ` +
          'and the viewers already in it never left',
      )
    }
    return { ...session, resumed }
  } catch (err) {
    if (!isConflict(err)) throw err
    conflict = err
  }
  // Not a resume this time: the relay has just refused this install's claim on
  // the id (an older relay, or a registration made without a key), so the
  // earlier share is ended with its own token the way it always was, and the
  // retry registers a clean new share.
  if (await settleEarlierShare(relay, sessionId, endLeftoverServer, keepServer, false)) {
    try {
      return { ...(await relay.createSession(sessionId, directory, title, key)), resumed: false }
    } catch (err) {
      if (!isConflict(err)) throw err
      conflict = err
    }
  }
  // An ended share of another install reserved the id: no share holds it, so
  // "stop it where it was started" sent the owner looking for one that does
  // not exist. The install whose owner.key registered it is the one that can
  // (this key did not match it) — another machine or HOME, or this one before
  // its owner.key was lost.
  if (conflict.relayError === 'session reserved') {
    throw new Error(
      `session ${sessionId} is reserved on the relay (409) for the install that shared it last, ` +
        'for 30 days after that share ended — no share of it is running to stop; share it again from that install ' +
        '(the one whose ~/.agents/skills/remote-control/state/owner.key registered it), or share another session',
    )
  }
  // Nothing here can end it: the token belongs to whoever registered it.
  throw new Error(
    `session ${sessionId} is already registered on the relay (409) by a share this machine has no record of — ` +
      'end it with /remote-control/stop where it was started, or wait for the relay to expire it ' +
      '(by default after a day without activity)',
  )
}

/**
 * Deal with an earlier share of `sessionId` that this machine recorded, before a
 * new share of it is registered. Resolves with whether there was one.
 *
 * - Its bridge still runs: throws, naming the pid and how to end that share.
 *   Taking it over would delete its registration under its viewers.
 * - Its bridge is gone and `resume` allows it: the registration is LEFT ON THE
 *   RELAY and its state file left on disk, so the registration that follows can
 *   present the code in it and continue that very share (see registerShare and
 *   resumableCode). Nothing is revoked, so the viewers already in stay in and
 *   the code the owner handed out goes on working.
 * - Its bridge is gone and it cannot be taken back — another relay's share, no
 *   code recorded, or a retry after the relay refused this install's claim:
 *   ends its relay registration with the bridge_token from its state, on the
 *   relay it was registered on (see shareRelay), drops that state and, as
 *   `endLeftoverServer` allows, the `opencode serve` it spawned — what `stop`
 *   would have done. Throws when that relay cannot be told, keeping the state so
 *   a retry or `stop` still can.
 *
 * The `opencode serve` an earlier share left behind is dealt with the same way
 * whichever of the last two happened: it is orphaned either way, and detection
 * runs next. A spawned server that is kept running and still is that server is
 * handed to `keepServer` with its state, which on the ending path is the only
 * record of it left: the new share has to take it over (see keptServerOf in
 * startBridge).
 */
async function settleEarlierShare(
  relay: RelayClient,
  sessionId: string,
  endLeftoverServer: LeftoverServerPolicy,
  keepServer: (earlier: SessionState) => void,
  resume: boolean,
): Promise<boolean> {
  const state = loadSessionState(sessionId)
  if (!state) return false
  if (shareBridgeRunning(state)) {
    throw new Error(
      `session ${sessionId} is already shared from this machine (bridge pid ${state.pid ?? 'unknown'}) — ` +
        `run /remote-control/stop (or \`bridge stop --session-id ${sessionId}\`) to end that share first`,
    )
  }
  if (resume && resumableCode(sessionId, relay) !== undefined) {
    // Deliberately no DELETE and no clearOwnSessionState: both are what the
    // registration about to be made needs in place. The old bridge_token still
    // owns the share until then, so a start that fails anywhere below leaves
    // `stop` able to end it — which the ending path could not.
    console.warn(
      `bridge: taking back the earlier share of session ${sessionId}; its bridge (pid ${state.pid}) was no ` +
        'longer running — its access code and the viewers already in it are kept',
    )
  } else {
    let failure: string | undefined
    try {
      const status = await shareRelay(state, relay).deleteSession(sessionId, state.bridge_token)
      // 404: the relay holds nothing under this token any more (expired, or
      // registered again by someone else) — nothing of ours left to end.
      if (status !== 204 && status !== 404) failure = `relay answered ${status}`
    } catch (err) {
      failure = describeRelayError(err)
    }
    if (failure !== undefined) {
      // `stop` as the way out: the earlier share may sit on a relay the owner
      // has since moved away from and that will never answer again, and `stop`
      // drops it on this machine either way.
      throw new Error(
        `session ${sessionId} is still registered by an earlier share whose bridge (pid ${state.pid}) is gone, ` +
          `and it could not be ended on the relay (${failure}) — try again, or run /remote-control/stop to drop it`,
      )
    }
    // By token, not by name: a concurrent start that settled this same dead share
    // while our DELETE was on its way may have registered and written its own
    // state already, and a failure of ours further on must not cost it that.
    clearOwnSessionState(sessionId, state.bridge_token)
    console.warn(`bridge: ended the earlier share of session ${sessionId}; its bridge (pid ${state.pid}) was no longer running`)
  }
  // On the ending path the state just dropped was the only record of that
  // server: a server kept here is handed on with it, to the share that takes
  // it over.
  const endServer =
    typeof endLeftoverServer === 'boolean'
      ? endLeftoverServer
      : state.server_pid !== undefined &&
        (await serverListensOnPort(state.server_pid, endLeftoverServer.namedPort)) === false
  if (!endServer) {
    if (spawnedServerRunning(state)) keepServer(state)
  } else if (terminateSpawnedServer(state.server_pid, state.started_at)) {
    // Detection runs next, and a server still shutting down answers its health
    // probe like any other: the new share would attach to it and lose it a
    // moment later.
    const deadline = Date.now() + LEFTOVER_SERVER_EXIT_WAIT_MS
    while (pidAlive(state.server_pid!) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  return true
}

/**
 * Whether the `opencode serve` a share recorded as `server_pid` still runs as
 * that server — the check `stop` makes before signalling it, so a recycled pid
 * is never taken over. Never throws: without `ps` it answers no.
 */
function spawnedServerRunning(state: SessionState, inspect: (pid: number) => ProcessSnapshot | null = describeProcess): boolean {
  const pid = state.server_pid
  if (!pid || !(pid > 1) || pid === process.pid) return false
  let snapshot: ProcessSnapshot | null
  try {
    snapshot = inspect(pid)
  } catch {
    snapshot = null
  }
  return snapshot !== null && refuseAsSpawnedServer(snapshot, state.started_at) === null
}

/**
 * The relay client a recorded share's bridge_token may be sent with: the one
 * for the relay that share was registered on, which issued the token.
 *
 * `current` is the relay this command was pointed at — `--relay`, or whatever
 * REMOTE_CONTROL_RELAY says by now — and the owner may have switched it since
 * the share started. Settling, stopping and probing a share used to send its
 * token there: a self-hosted or mistyped relay the owner moved to was handed
 * the live credential of a share on another one, and its operator could
 * connect to that relay as the share's bridge (serving its viewers, reading
 * their prompts) or read its directory and title — the very leak the owner_key
 * is bound to the relay's origin to prevent (see ownerKey). Nor did it end
 * anything: that relay answered 404, which reads as "already gone".
 *
 * Decided by origin, as the owner_key is: a trailing slash or a default port
 * name the same relay, which keeps the caller's client — its URL as given and
 * the legacy api key meant for it. Another relay gets a client of its own,
 * with no key; a state that names no usable relay (hand-edited, truncated)
 * yields one fetch refuses before any request is made, so its token goes
 * nowhere.
 */
function shareRelay(state: SessionState, current: RelayClient): RelayClient {
  const recorded = originOf(state.relay)
  return recorded !== undefined && recorded === originOf(current.url) ? current : new RelayClient(state.relay)
}

/**
 * The access code a share of `sessionId` recorded on this machine may be
 * re-registered with on `relay`, so that relay continues that share — same
 * code, same viewers — instead of replacing it (see RelayClient.createSession).
 * Undefined when there is nothing to present.
 *
 * Undefined when no state is recorded, which is the whole of the contract with
 * settleEarlierShare: a share it ENDED has its state file dropped, so there is
 * no code left to present and the registration that follows is an ordinary new
 * share, exactly as it was. Undefined too when the state is unreadable or
 * carries no code (hand-edited, truncated, or written by a version that did
 * not record one).
 *
 * And undefined for a share recorded against ANOTHER relay, decided by origin
 * the way shareRelay decides where that share's bridge_token may be sent, and
 * for the same reason: the code is a live credential of a share on that relay,
 * and a self-hosted or mistyped one the owner has since moved to has no
 * business being handed it. It would not open anything here anyway — this relay
 * never minted it — so there is nothing to weigh against the leak.
 */
function resumableCode(sessionId: string, relay: RelayClient): string | undefined {
  const state = loadSessionState(sessionId)
  if (!state || typeof state.access_code !== 'string' || state.access_code === '') return undefined
  const recorded = originOf(state.relay)
  return recorded !== undefined && recorded === originOf(relay.url) ? state.access_code : undefined
}

/** How long a start waits for the `opencode serve` of a dead share to exit once signalled. */
const LEFTOVER_SERVER_EXIT_WAIT_MS = 5_000

/**
 * Whether settling a dead share may end the `opencode serve` it left behind:
 * yes or no outright, or — for a start that names its server (--port, a URL)
 * — the port it named, and then only when that leftover is known to listen on
 * another port (serverListensOnPort answers false). While it may be the named
 * server (listed on that port, or not listed at all) it is kept: ending it left
 * the start nothing to run on, "local opencode server unreachable" on the port
 * it had just emptied itself. A kept server is taken over by the new share
 * (see keptServerOf in startBridge), whichever server that share runs on.
 */
type LeftoverServerPolicy = boolean | { namedPort: number | undefined }

/** The port an http(s) URL names, or its scheme's default; undefined for anything else. */
function urlPort(url: string): number | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.port !== '') return Number(parsed.port)
    return parsed.protocol === 'http:' ? 80 : parsed.protocol === 'https:' ? 443 : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the `opencode serve` a share recorded as `serverPid` listens on
 * `port`: true when a listener on that port is the server or runs under it (an
 * `opencode` on PATH that is a wrapper starts the real binary, which is what
 * listens), false when every listener that is the server's is on another port,
 * and undefined when there is nothing to decide from — no listener of the
 * server's is listed (no lsof, or it is already gone) or no port is known.
 *
 * Never throws. `listeners` and `inspectParent` are injectable so the decision
 * can be tested deterministically.
 */
export async function serverListensOnPort(
  serverPid: number,
  port: number | undefined,
  listeners: () => Promise<Listener[]> = listListeners,
  inspectParent: (pid: number) => ProcessParent | null = describeParent,
): Promise<boolean | undefined> {
  if (port === undefined || !(serverPid > 1)) return undefined
  let listed: Listener[]
  try {
    listed = await listeners()
  } catch {
    return undefined
  }
  // The listener itself or one of its SHARE_ANCESTRY_DEPTH nearest ancestors.
  const underServer = (pid: number): boolean => {
    let current = pid
    for (let depth = 0; depth < SHARE_ANCESTRY_DEPTH && current !== serverPid; depth++) {
      let parentPid: number | undefined
      try {
        parentPid = inspectParent(current)?.ppid
      } catch {
        return false
      }
      if (parentPid === undefined || !(parentPid > 1)) return false
      current = parentPid
    }
    return current === serverPid
  }
  const servers = listed.filter((l) => underServer(l.pid))
  if (servers.length === 0) return undefined
  return servers.some((l) => l.port === port)
}

/**
 * Whether the bridge a state file names is still running.
 *
 * Says "running" whenever it cannot tell — state from a version that recorded
 * no pid, or a pid that exists but `ps` cannot describe: mistaking a live share
 * for a dead one deletes it under its viewers, while the opposite mistake only
 * asks the owner to run `stop`. The pid is otherwise held to the same identity
 * check `stop` uses before signalling, so a pid recycled after a reboot does
 * not keep a dead share alive.
 */
function shareBridgeRunning(state: SessionState, inspect: (pid: number) => ProcessSnapshot | null = describeProcess): boolean {
  // The one state that says outright that its pid is not a bridge: a start
  // that registered its share, never got its bridge up, and left the share
  // registered because it had resumed one (see SessionState.bridge_gone).
  if (state.bridge_gone) return false
  const pid = state.pid
  if (!pid) return true
  // Our own pid: a share this very process runs (a library caller), unless the
  // state predates this process — a pid handed out again after a reboot.
  if (pid === process.pid) return state.started_at >= Date.now() - process.uptime() * 1000 - 1000
  let snapshot: ProcessSnapshot | null
  try {
    snapshot = inspect(pid)
  } catch {
    snapshot = null
  }
  if (!snapshot) return pidAlive(pid)
  return refuseToSignal(snapshot, state.started_at) === null
}

/**
 * End a share: delete the relay session — on the relay the share was
 * registered on, which `relayUrl` only is when the owner has not switched
 * relays since (see shareRelay) — then take the share down on this machine
 * (state file, bridge process, the server it spawned).
 *
 * Resolves with nothing when the relay confirmed, and with a warning to show
 * the owner when it could not be told — the local teardown happens either way.
 */
export async function stopBridge(
  relayUrl: string,
  sessionId: string,
  apiKey?: string,
): Promise<string | undefined> {
  // Deleting a session requires its OWN bridge_token (never a shared key) —
  // read it from the state `start` persisted.
  const state = loadSessionState(sessionId)
  if (!state) {
    // Nothing to do: without the owner token we cannot (and should not)
    // delete the session. Treat as already-stopped (idempotent).
    return
  }
  // The relay's answer must not decide whether the share ends here. A failed
  // or unanswered DELETE used to throw before anything local happened, and
  // that is exactly when a relay restarts behind nginx (502), is down, or the
  // owner's network cannot reach it: the bridge treats all of those as a
  // passing outage and keeps re-dialling, and since the relay persists
  // sessions, the share came back with it — same access code — while the owner
  // had been told only that stop failed. Once the bridge and this state file
  // (the only copies of the bridge_token) are gone, nothing can re-attach the
  // relay's record to a bridge; it proxies nothing and expires on its own.
  let relayFailure: string | undefined
  try {
    // On the relay the share was registered on, whatever `relayUrl` says now (see shareRelay).
    const status = await shareRelay(state, new RelayClient(relayUrl, apiKey)).deleteSession(sessionId, state.bridge_token)
    // 404 means the session is already gone — stop stays idempotent.
    if (status !== 204 && status !== 404) relayFailure = `relay answered ${status}`
  } catch (err) {
    relayFailure = describeRelayError(err)
  }
  clearSessionState(sessionId)
  terminateBridgeProcess(state.pid, state.started_at)
  // The bridge kills its own `opencode serve` on every exit path that runs
  // JavaScript — but a SIGKILL, a panic or a reboot runs none of them, and the
  // server then outlives the share, holding its port until the machine is
  // rebooted. Worse, the next `start` detects that stale server and attaches to
  // it, so a new share can end up bound to a server left over from an old one.
  // Finish the cleanup here, with the same identity check the bridge pid gets.
  terminateSpawnedServer(state.server_pid, state.started_at)
  if (relayFailure === undefined) return
  // Not a failure — the share did end, which is what was asked — but not a
  // clean stop either, and it must not read like one.
  return (
    `Remote control stopped on this machine, but the relay could not be told (${relayFailure}). ` +
    'The bridge is gone, so the share cannot reconnect; the relay expires the session on its own.'
  )
}

/** A relay DELETE (or status probe, under the same deadline) that threw, in words the owner can act on. */
function describeRelayError(err: unknown): string {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return `relay did not answer within ${Math.round(relayDeleteTimeoutMs() / 1000)} s`
  }
  // RelayClient already names the relay and the network cause (see fetchFrom):
  // its errno alone said neither which relay nor, for TLS, what was wrong.
  return describeError(err)
}

/** Command lines that belong to an `opencode serve` the bridge started. */
const SERVE_COMMAND_RE = /(^|[/\\])opencode(\.exe)?\s+serve(\s|$)/

/**
 * SIGTERM a leftover `opencode serve`, but only if the pid really is one.
 *
 * Same reasoning as terminateBridgeProcess: the pid comes from a state file
 * that can outlive the process it names, and pids are recycled. Never throws —
 * `stop` stays idempotent even where `ps` is unavailable. Returns whether the
 * server was signalled.
 */
export function terminateSpawnedServer(
  pid: number | undefined,
  startedAt?: number,
  inspect: (pid: number) => ProcessSnapshot | null = describeProcess,
): boolean {
  if (!pid || pid === process.pid) return false
  let snapshot: ProcessSnapshot | null = null
  try {
    snapshot = inspect(pid)
  } catch {
    snapshot = null
  }
  if (!snapshot) return false // already gone: nothing to clean up, nothing to report
  const refusal = refuseAsSpawnedServer(snapshot, startedAt)
  if (refusal) {
    console.warn(`bridge stop: not signalling opencode server pid ${pid} — ${refusal}`)
    return false
  }
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    // Already gone (ESRCH) or not ours (EPERM).
    return false
  }
}

/**
 * Why a live pid a share recorded as `server_pid` is no longer the
 * `opencode serve` that share spawned, or null when it still is: pids are
 * recycled, so the command line must still be a server's and the process must
 * not have started after the share was registered.
 */
function refuseAsSpawnedServer(snapshot: ProcessSnapshot, startedAt?: number): string | null {
  if (!SERVE_COMMAND_RE.test(snapshot.command)) {
    return `pid now belongs to an unrelated process: ${snapshot.command.slice(0, 120)}`
  }
  if (startedAt !== undefined && snapshot.startedAt !== undefined && snapshot.startedAt > startedAt + PID_START_SLACK_MS) {
    return 'it started after this share was registered'
  }
  return null
}

/**
 * Whether the process listening on a port is — or runs under — the
 * `opencode serve` a share on this machine recorded as its own (`server_pid`
 * in its state file), whether or not that share's bridge still runs.
 *
 * belongsToRunningShare cannot see the server of a bridge killed with -9 (or
 * crashed): it is re-parented away, and only the state file still says whose it
 * is. Such a server is never the owner's own, and attaching to it gave a share
 * a server that nothing would end, or that a `stop` of the stale share would
 * end under it. The recorded pid is held to the check `stop` uses before
 * signalling it, so a pid recycled into the owner's own server is not claimed;
 * the listener's ancestors are looked at too, for an `opencode` on PATH that is
 * a wrapper around the real binary.
 *
 * Never throws: without `ps` nothing is claimed. `states`, `inspect` and
 * `inspectParent` are injectable so the decision can be tested deterministically.
 */
export function spawnedByRecordedShare(
  pid: number,
  states: SessionState[] = listSessionStates(),
  inspect: (pid: number) => ProcessSnapshot | null = describeProcess,
  inspectParent: (pid: number) => ProcessParent | null = describeParent,
): boolean {
  const recorded = states.filter((s) => typeof s.server_pid === 'number' && s.server_pid > 1 && s.server_pid !== process.pid)
  if (recorded.length === 0) return false
  const safely = <T>(fn: () => T): T | null => {
    try {
      return fn()
    } catch {
      return null
    }
  }
  let current = pid
  for (let depth = 0; depth <= SHARE_ANCESTRY_DEPTH; depth++) {
    const owners = recorded.filter((s) => s.server_pid === current)
    if (owners.length > 0) {
      const snapshot = safely(() => inspect(current))
      if (snapshot && owners.some((s) => refuseAsSpawnedServer(snapshot, s.started_at) === null)) return true
    }
    const parentPid = safely(() => inspectParent(current))?.ppid
    if (parentPid === undefined || !(parentPid > 1)) return false
    current = parentPid
  }
  return false
}

/** What the OS reports about a live pid: its command line and, when `ps`
 * supports `lstart`, when that process started (epoch ms). */
export interface ProcessSnapshot {
  command: string
  startedAt?: number
}

/**
 * Command lines that belong to a bridge. Covers every way the CLI is launched:
 * the prebuilt plugin bundle (`plugin/bridge/remote-control-bridge.cjs`), the
 * skill layout install.sh writes (`~/.agents/skills/remote-control/bin/index.js`),
 * a repo checkout (`bridge/dist/index.js`, `bridge/src/index.ts`) and the npm
 * bin shim (`node_modules/.bin/bridge`).
 */
const BRIDGE_ENTRY_RE =
  /(remote-control-bridge(\.cjs)?|remote-control[/\\]bin[/\\]index\.(js|cjs|mjs)|bridge[/\\](dist[/\\])?index\.(js|cjs|mjs|ts)|[/\\]\.bin[/\\]bridge(\s|$))/
/** The interpreter a bridge always runs under. */
const NODE_EXEC_RE = /(^|[/\\])(node|nodejs|node\d+(\.\d+)*|bun|deno|tsx|ts-node)(\.exe)?$/

/**
 * How much later than the recorded `started_at` a process may have started and
 * still be the bridge that wrote it. The state file is written AFTER the
 * process is up (registration talks to the relay first), so the bridge's own
 * start time is always EARLIER than `started_at`; a process that appeared
 * after it is a different one wearing a recycled pid. The slack absorbs a slow
 * registration, ps's one-second resolution and clock jitter.
 */
const PID_START_SLACK_MS = 120_000

/** Read a pid's command line (and start time when available); null if the pid
 * is gone or `ps` cannot answer. Never throws. */
function describeProcess(pid: number): ProcessSnapshot | null {
  const ps = (format: string): string | null => {
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', format], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const line = out.split('\n')[0]?.trim() ?? ''
      return line.length > 0 ? line : null
    } catch {
      // No such pid, `ps` missing, or a format this ps does not know.
      return null
    }
  }
  // One call for both fields. `lstart` is a fixed 5-token date ("Thu Sep 11
  // 09:12:13 2026") on both macOS and Linux, so the command is everything
  // after it. A ps build that rejects `lstart` fails the whole call, hence the
  // command-only retry — losing the start time must never lose the command.
  const combined = ps('lstart=,command=')
  if (combined) {
    const m = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S.*)$/.exec(combined)
    const started = m ? Date.parse(m[1]!) : NaN
    if (m && Number.isFinite(started)) return { command: m[2]!, startedAt: started }
  }
  const command = ps('command=')
  return command ? { command } : null
}

/** Whether a command line is a node process running the bridge entry point. */
function isBridgeCommand(command: string): boolean {
  const exec = command.trim().split(/\s+/)[0] ?? ''
  return NODE_EXEC_RE.test(exec) && BRIDGE_ENTRY_RE.test(command)
}

/** A live pid's parent pid and command line. */
export interface ProcessParent {
  ppid: number
  command: string
}

/** Read a pid's parent and command line; null if the pid is gone or `ps` cannot answer. Never throws. */
function describeParent(pid: number): ProcessParent | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'ppid=,command='], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const m = /^\s*(\d+)\s+(\S.*)$/.exec(out.split('\n')[0] ?? '')
    return m ? { ppid: Number(m[1]), command: m[2]!.trim() } : null
  } catch {
    return null
  }
}

/**
 * How many generations above a listening process to look for the bridge that
 * spawned it. The bridge's child is normally the listener itself; an `opencode`
 * on PATH that is a wrapper starting the real binary puts the listener a level
 * or two further down.
 */
const SHARE_ANCESTRY_DEPTH = 4

/**
 * Whether the process listening on a port was started by a share that is still
 * running on this machine: a bridge process — or this very process, for a
 * library caller running several shares — is among its ancestors.
 *
 * Two concurrent shares used to end up on ONE server: the second `start`
 * detected the first share's `opencode serve` like any user-run server and
 * attached to it, and ending the first share killed that server under the
 * second. The parent link answers "whose is this server" where the state files
 * cannot: it exists from the moment of the spawn, while a share's state is
 * written only after the relay accepted it (seconds later on a slow uplink); it
 * reaches the listener even when the pid the bridge spawned was a wrapper; and
 * it cannot go stale — a server whose bridge was killed with -9 is re-parented
 * away and is no longer claimed by anyone.
 *
 * Never throws: without `ps` nothing is claimed, which is detection's old
 * behaviour. `inspect` is injectable so the walk can be tested deterministically.
 */
export function belongsToRunningShare(
  pid: number,
  inspect: (pid: number) => ProcessParent | null = describeParent,
): boolean {
  const lookup = (p: number): ProcessParent | null => {
    try {
      return inspect(p)
    } catch {
      return null
    }
  }
  let entry = lookup(pid)
  for (let depth = 0; entry && depth < SHARE_ANCESTRY_DEPTH; depth++) {
    const parentPid = entry.ppid
    if (!(parentPid > 1)) return false // init/launchd: nobody's child any more
    if (parentPid === process.pid) return true
    entry = lookup(parentPid)
    if (entry && isBridgeCommand(entry.command)) return true
  }
  return false
}

/** Why this pid must not be signalled, or null when it is safe to. */
function refuseToSignal(snapshot: ProcessSnapshot | null, startedAt?: number): string | null {
  if (!snapshot) return 'no such process (already gone)'
  if (!isBridgeCommand(snapshot.command)) {
    return `pid now belongs to an unrelated process: ${snapshot.command.slice(0, 120)}`
  }
  if (startedAt !== undefined && snapshot.startedAt !== undefined && snapshot.startedAt > startedAt + PID_START_SLACK_MS) {
    return 'process started after this share was registered (recycled pid)'
  }
  return null
}

/**
 * Signal the long-running `start` process so it shuts down (its SIGTERM
 * handler closes the WS and kills the `opencode serve` it spawned). Without
 * this, `stop` only removed the relay session and left both processes — and
 * the spawned server's port — behind.
 *
 * The pid comes from a state file that outlives a bridge killed with -9, a
 * panic or a reboot, and the OS recycles pids — so `stop` used to SIGTERM
 * whatever stranger had inherited the number. Verify the pid still runs a
 * bridge (command line, corroborated by the process's own start time) before
 * signalling. Never signals the caller itself (the library path runs stop
 * inside the bridge process), and never throws: `stop` stays idempotent even
 * when `ps` is unavailable.
 *
 * `inspect` is injectable so the check itself can be tested deterministically.
 */
export function terminateBridgeProcess(
  pid: number | undefined,
  startedAt?: number,
  inspect: (pid: number) => ProcessSnapshot | null = describeProcess,
): void {
  if (!pid || pid === process.pid) return
  let snapshot: ProcessSnapshot | null = null
  try {
    snapshot = inspect(pid)
  } catch {
    // An unusable lookup must not turn `stop` into a crash — and must not turn
    // into a blind kill either: fall through with no evidence, which refuses.
    snapshot = null
  }
  const refusal = refuseToSignal(snapshot, startedAt)
  if (refusal) {
    // Silence here would be indistinguishable from a successful stop, and the
    // stale-state case is exactly when the user wonders why nothing happened.
    console.warn(`bridge stop: not signalling pid ${pid} — ${refusal}`)
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Raced with its own exit (ESRCH) or not ours (EPERM) — nothing to clean up.
  }
}

/** Newest ROOT session in the CURRENT working directory. Subagent sessions
 * have a parentID and are never what the user is looking at. We query with
 * `?directory=` because the opencode instance (e.g. the desktop app) hosts
 * many projects at once — an unfiltered list would pick a session from an
 * unrelated project. */
async function pickSession(opencode: OpencodeClient): Promise<OpencodeSessionInfo> {
  const cwd = process.cwd()
  const sessions = (await opencode.getSessions(cwd)) as OpencodeSessionInfo[]
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new Error(`no opencode sessions found in ${cwd}`)
  }
  const roots = sessions.filter((s) => !s.parentID)
  const candidates = roots.length > 0 ? roots : sessions
  return candidates.sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))[0]!
}

/**
 * Session detail for an explicitly requested id. Best effort: an unreachable
 * or unknown session leaves the caller on its previous fallbacks rather than
 * failing the share.
 */
async function fetchSession(
  opencode: OpencodeClient,
  sessionId: string,
): Promise<OpencodeSessionInfo | undefined> {
  try {
    const out = await opencode.request('GET', `/session/${encodeURIComponent(sessionId)}`)
    if (out.status !== 200) return undefined
    const info = JSON.parse(out.body) as OpencodeSessionInfo
    return info && typeof info.id === 'string' ? info : undefined
  } catch {
    return undefined
  }
}

/** Whether a pid still exists. EPERM means it does, it just is not ours to signal. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * One watchdog health probe of the local opencode server: undefined when it
 * answered OK, otherwise what went wrong, in words for the log — a timeout, a
 * refused connection and an HTTP error are different stories for an owner
 * reading why their share ended.
 */
async function probeOpencode(opencodeUrl: string, password?: string): Promise<string | undefined> {
  const timeoutMs = watchdogProbeTimeoutMs()
  try {
    const res = await fetch(`${opencodeUrl}${config.healthPath}`, {
      headers: { Authorization: opencodeAuthHeader(password) },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok ? undefined : `HTTP ${res.status}`
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') return `no answer within ${timeoutMs} ms`
    // fetch reports every network failure as "fetch failed"; the errno is on its cause.
    const code = (err as { cause?: { code?: unknown } } | undefined)?.cause?.code
    return `unreachable: ${typeof code === 'string' ? code : describeError(err)}`
  }
}

/* ---------------------------------- CLI ---------------------------------- */

/** Resolve the session id: explicit flag wins, else the most recent state
 * written by `start`. */
function resolveSessionId(flag: string | undefined): string | undefined {
  return flag ?? latestSessionState()?.session_id
}

const program = new Command()
program.name('bridge').description('OpenCode remote-control bridge')

program
  .command('start')
  .description('Register this session with the relay and serve proxy requests until stopped')
  .option('--relay <url>', 'relay base URL', config.defaultRelayUrl)
  .option('--api-key <key>', 'relay API key (optional; the public relay does not need it)')
  .option('--port <port>', 'opencode port (auto-detected when omitted)')
  .option('--session-id <id>', 'opencode session id (newest session when omitted)')
  .option('--owner-pid <pid>', 'stop sharing when this process (the OpenCode that started the share) exits')
  .action(async (opts: { relay: string; apiKey?: string; port?: string; sessionId?: string; ownerPid?: string }) => {
    const port = opts.port === undefined ? undefined : Number(opts.port)
    if (port !== undefined && !Number.isInteger(port)) {
      console.error('error: --port must be an integer')
      process.exitCode = 1
      return
    }
    const ownerPid = opts.ownerPid === undefined ? undefined : Number(opts.ownerPid)
    // Positive only: kill(0, 0) and kill(-1, 0) address process groups and
    // always succeed, so such an owner would never be seen to exit.
    if (ownerPid !== undefined && !(Number.isInteger(ownerPid) && ownerPid > 0)) {
      console.error('error: --owner-pid must be a positive integer')
      process.exitCode = 1
      return
    }
    let handle: BridgeHandle
    try {
      handle = await startBridge(opts.relay, opts.apiKey, { port, sessionId: opts.sessionId, ownerPid })
    } catch (err) {
      // describeError, not the message: every network failure's message is
      // "fetch failed", and what failed is on its cause. One line, so the
      // plugin's toast carries all of it.
      console.error(`bridge start failed: ${describeError(err)}`)
      process.exitCode = 1
      return
    }
    // Output contract: exactly two lines — the session link and the code.
    const relayBase = opts.relay.replace(/\/+$/, '')
    console.log(`${relayBase}${handle.viewer_url}`)
    console.log(`CODE: ${handle.access_code}`)
    const onSignal = () => void handle.stop()
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    process.on('SIGHUP', onSignal)
    const reason = await handle.closed
    // A share that ended on its own says why: this is the only line an owner
    // finds later (in the plugin's log), and "stopped" alone read the same for
    // a dead server, a revoked session and their own Ctrl+C.
    console.log(reason === undefined ? 'Remote control stopped.' : `Remote control stopped: ${reason}.`)
  })

program
  .command('stop')
  .description('End a remote-control session on the relay')
  .option('--relay <url>', 'relay base URL', config.defaultRelayUrl)
  .option('--api-key <key>', 'relay API key (optional)')
  .option('--session-id <id>', 'opencode session id (latest started when omitted)')
  .action(async (opts: { relay: string; apiKey?: string; sessionId?: string }) => {
    const sessionId = resolveSessionId(opts.sessionId)
    if (!sessionId) {
      console.error('error: no session id (pass --session-id or start a share first)')
      process.exitCode = 1
      return
    }
    // stopBridge treats a missing state file as already stopped, which kept
    // this printing "Remote control stopped." for a session that was never
    // shared from here. The plugin now passes the session the command was typed
    // in, so that is exactly what a stop in an unshared session hits while
    // other shares on this machine stay live — say so instead. Still a clean
    // exit: there is nothing running that the caller asked to end.
    if (!loadSessionState(sessionId)) {
      console.log(`session ${sessionId} is not shared from this machine — nothing to stop.`)
      return
    }
    try {
      // A relay that could not be told still exits 0 with its warning on
      // stdout: the share is down, so the plugin must report it stopped (and
      // scrub the logged code) rather than "stop failed", with the reason.
      const warning = await stopBridge(opts.relay, sessionId, opts.apiKey)
      console.log(warning ?? 'Remote control stopped.')
    } catch (err) {
      console.error(`bridge stop failed: ${describeError(err)}`)
      process.exitCode = 1
    }
  })

program
  .command('status')
  .description('Probe relay health, local opencode detection, and session presence')
  .option('--relay <url>', 'relay base URL', config.defaultRelayUrl)
  .option('--api-key <key>', 'relay API key (optional)')
  .option('--session-id <id>', 'opencode session id (latest started when omitted)')
  .action(async (opts: { relay: string; apiKey?: string; sessionId?: string }) => {
    let ok = true
    try {
      const res = await fetch(`${opts.relay}/health`, { signal: AbortSignal.timeout(5000) })
      console.log(`relay: ${res.ok ? 'ok' : `HTTP ${res.status}`} (${opts.relay})`)
      if (!res.ok) ok = false
    } catch (err) {
      console.log(`relay: unreachable (${opts.relay}): ${describeError(err)}`)
      ok = false
    }
    try {
      // A running share's own server answers nobody without its password (see
      // ensureOpenCodeServer), and this command is a different process with no
      // way to hold it — reporting the owner's working opencode as "not
      // detected" would be the report, not the truth.
      //
      // A port the owner named is the only one looked at, so `status` reports
      // on the server their shares actually run on (see namedOpencodePort).
      const named = namedOpencodePort()
      const port = await detectOpenCodePort(named === undefined ? undefined : [named], { acceptGuarded: true })
      console.log(`opencode: detected on port ${port}`)
    } catch {
      console.log('opencode: not detected')
      ok = false
    }
    const sessionId = resolveSessionId(opts.sessionId)
    if (sessionId) {
      const local = loadSessionState(sessionId)
      // The relay cannot tell a bridge that is re-dialling from one that died
      // without a word (SIGKILL, a crash, a reboot): both are "disconnected"
      // there, and the session stays "active" until it expires a day later. A
      // dead bridge's share looked alive apart from that one line, and status
      // exited 0. The pid this machine recorded can tell them apart.
      let bridgeProcess: string | undefined
      if (local?.pid) {
        if (shareBridgeRunning(local)) {
          bridgeProcess = `  bridge process: running (pid ${local.pid})`
        } else {
          bridgeProcess = `  bridge process: not running (pid ${local.pid}) — this share is stale, run stop to end it`
          ok = false
        }
      }
      // Pass our own bridge_token so the relay returns the owner-only fields
      // (directory, title) it withholds from the public presence view — to the
      // relay the share was registered on, the only one that issued the token
      // and knows the share, which is named when it is not --relay (see shareRelay).
      const ownerToken = local?.bridge_token
      const current = new RelayClient(opts.relay, opts.apiKey)
      const probe = local ? shareRelay(local, current) : current
      const where = probe === current ? '' : ` (relay ${originOf(probe.url) ?? 'unknown'})`
      let probed: { status: number; body?: SessionStatus }
      try {
        probed = await probe.getSession(sessionId, ownerToken)
      } catch (err) {
        // That relay is not always the one --relay names and the health check
        // above found "ok": an owner who moved off a relay that is down now
        // asks it all the same. Its failure used to escape the command as a
        // stack trace on stderr, which the plugin does not show for a status,
        // and took the session line and the stale-share hint with it.
        console.log(`session ${sessionId}${where}: unknown — ${describeRelayError(err)}`)
        if (bridgeProcess) console.log(bridgeProcess)
        process.exitCode = 1
        return
      }
      const { status, body } = probed
      if (status === 404) {
        console.log(`session ${sessionId}${where}: not found`)
        if (bridgeProcess) console.log(bridgeProcess)
        ok = false
      } else if (status !== 200 || !body) {
        console.log(`session ${sessionId}${where}: HTTP ${status}`)
        if (bridgeProcess) console.log(bridgeProcess)
        ok = false
      } else {
        // Every line below quotes the relay, so none of them assumes anything
        // of what it sent: the fields are already bounded and stripped of
        // terminal control sequences (see parseSessionStatus), and the two
        // numbers are printed as '?' rather than as NaN when they were not
        // numbers at all. A status that is neither active nor closed reads
        // 'unknown'.
        const age = body.created_at === undefined ? '?' : formatDuration(Date.now() - body.created_at)
        console.log(`session ${sessionId}${where}: ${body.status}`)
        console.log(`  bridge: ${body.bridge_connected ? 'connected' : 'disconnected'}`)
        if (bridgeProcess) console.log(bridgeProcess)
        // A share with no bridge on the relay serves no viewer right now, whatever the reason.
        if (!body.bridge_connected) ok = false
        console.log(`  viewers: ${body.viewer_count ?? '?'}`)
        console.log(`  alive: ${age}`)
        if (body.title !== undefined) console.log(`  title: ${body.title || '(untitled)'}`)
        if (body.directory !== undefined) console.log(`  directory: ${body.directory}`)
      }
    }
    if (!ok) process.exitCode = 1
  })

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h`
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

// Run the CLI only when executed directly (not when imported by tests).
// A bundled single-file build (esbuild CJS) has a different argv[1] relation
// to import.meta.url, so always run when this file is the process entrypoint.
const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href ||
    process.argv[1].endsWith('remote-control-bridge.cjs') ||
    process.argv[1].endsWith('bridge/index.cjs'))
if (invokedDirectly) {
  program.parseAsync(process.argv).catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
