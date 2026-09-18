import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createApp } from '../../relay/src/server'
import { Store } from '../../relay/src/store'
import { BridgeClient } from '../../relay/src/ws/bridge'
import { opencodeAuthHeader } from '../src/config'
import { startBridge, type BridgeHandle } from '../src/index'
import { RelayClient } from '../src/relay'
import { loadSessionState, ownerKey, saveSessionState, type SessionState } from '../src/state'

/**
 * The case the owner cares about, end to end through the real bridge: a viewer
 * is holding a token, the share dies the way a crashed opencode kills it (no
 * teardown, no DELETE, just a state file and a dead pid), the share is started
 * again — and BOTH the old viewer token and the old access code still work.
 *
 * Two things used to end that viewer's session. The bridge settled the earlier
 * share by DELETING its relay registration before registering again, and the
 * relay minted a fresh code and revoked every viewer token on every
 * registration. So the tab went back to a code-entry page holding a code that
 * no longer existed, and the owner — who is the only one with the new code,
 * in bridge.log on the machine that just crashed — had no way to tell anyone.
 *
 * Now a start that can re-register the very share the state file describes
 * takes it back instead of ending it, and presents the code that state file
 * holds so the relay continues the share rather than replacing it. `stop`
 * still ends everything: that is checked here too.
 *
 * Stand-ins: a relay built from source in this process (so the viewer tokens
 * it minted can be checked directly), an opencode server over node:http, and a
 * process whose command line reads like an `opencode serve`. HOME is a temp
 * dir, so no real state, owner key or share is ever touched.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

let relay: Server
let relayUrl: string
let store: Store
let hub: BridgeClient
let opencode: Server
let opencodeUrl: string
let root: string
let savedHome: string | undefined
const handles: BridgeHandle[] = []

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** The pid of a process that has already exited: what a state file names after a crash. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => child.once('exit', resolve))
  return child.pid!
}

beforeAll(async () => {
  savedHome = process.env.HOME
  root = mkdtempSync(path.join(tmpdir(), 'rc-share-resume-'))
  mkdirSync(path.join(root, 'home'))
  process.env.HOME = path.join(root, 'home')
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (req.headers.authorization !== opencodeAuthHeader()) return json(res, 401, { error: 'unauthorized' })
    if (url.pathname === '/global/health') return json(res, 200, { healthy: true })
    if (url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': connected\n\n')
      return
    }
    const m = /^\/session\/([^/]+)$/.exec(url.pathname)
    if (m) return json(res, 200, { id: decodeURIComponent(m[1]!), directory: root, title: 'resume' })
    json(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`

  store = new Store()
  relay = createServer()
  hub = new BridgeClient(relay, store)
  relay.on('request', createApp(store, hub))
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop().catch(() => {})
  vi.restoreAllMocks()
})

afterAll(async () => {
  hub.close()
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(root, { recursive: true, force: true })
})

async function start(sessionId: string): Promise<BridgeHandle> {
  const handle = await startBridge(relayUrl, undefined, { opencodeUrl, sessionId })
  handles.push(handle)
  return handle
}

/**
 * A share of `id` registered the way THIS install registers one (its owner
 * key), with a viewer already in, and then killed the way a crash kills it:
 * no teardown, no DELETE, only the state file and a pid that is gone.
 */
async function crashedShare(id: string, extra: Partial<SessionState> = {}) {
  const session = await new RelayClient(relayUrl).createSession(id, root, 'crashed', ownerKey(relayUrl, id))
  const { viewer_token } = store.activate(session.access_code, id)
  expect(store.verifyViewer(id, viewer_token)).toBe(true)
  const state: SessionState = {
    session_id: id,
    access_code: session.access_code,
    bridge_token: session.bridge_token,
    relay: relayUrl,
    started_at: Date.now(),
    pid: await exitedPid(),
    ...extra,
  }
  saveSessionState(state)
  return { ...session, viewer_token, state }
}

test('the state file that holds the share is the owner\'s alone', () => {
  saveSessionState({
    session_id: 'ses_resume_perms',
    access_code: 'AAAAAA',
    bridge_token: 'tok',
    relay: relayUrl,
    started_at: Date.now(),
  })
  const stateDir = path.join(root, 'home', '.agents', 'skills', 'remote-control', 'state')
  const file = path.join(stateDir, 'ses_resume_perms.json')
  if (process.platform !== 'win32') {
    // The access code has always lived here beside the bridge_token; it is what
    // a start now presents to take its share back, so the file's mode is worth
    // pinning: 0600, in a 0700 directory.
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(stateDir).mode & 0o777).toBe(0o700)
    // ...whatever mode the file already had. writeFileSync's `mode` applies
    // only when it CREATES the file, so a state file that was once world
    // readable (a restored backup, a umask experiment, a hand edit) kept its
    // mode through every rewrite, code and bridge_token included.
    chmodSync(file, 0o644)
    saveSessionState({ ...loadSessionState('ses_resume_perms')!, started_at: Date.now() })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  }
  expect(loadSessionState('ses_resume_perms')?.access_code).toBe('AAAAAA')
})

test.skipIf(process.platform === 'win32')(
  'a share started again after a crash keeps the viewer in and the code alive',
  async () => {
    const crashed = await crashedShare('ses_resume_e2e')

    const handle = await start('ses_resume_e2e')

    // The code the owner already gave out is the code the start comes up with.
    expect(handle.access_code).toBe(crashed.access_code)
    // The tab the viewer is holding is still in, and so is the code, for
    // anyone who was given it and has not joined yet.
    expect(store.verifyViewer('ses_resume_e2e', crashed.viewer_token)).toBe(true)
    expect(store.getSessionByViewerToken(crashed.viewer_token)?.id).toBe('ses_resume_e2e')
    expect(store.activate(crashed.access_code, 'ses_resume_e2e').viewer_token).toBeTruthy()

    // The dead share's own credential is gone all the same, and the state file
    // now holds the live one beside the code that survived.
    const state = loadSessionState('ses_resume_e2e')
    expect(state?.pid).toBe(process.pid)
    expect(state?.access_code).toBe(crashed.access_code)
    expect(state?.bridge_token).not.toBe(crashed.bridge_token)
    expect(await new RelayClient(relayUrl).deleteSession('ses_resume_e2e', crashed.bridge_token)).toBe(404)
    expect(hub.isConnected('ses_resume_e2e')).toBe(true)
  },
  30_000,
)

test.skipIf(process.platform === 'win32')(
  'stop after such a restart still ends everything: code dead, viewer out, session gone',
  async () => {
    const crashed = await crashedShare('ses_resume_e2e_stop')
    const handle = await start('ses_resume_e2e_stop')
    expect(handle.access_code).toBe(crashed.access_code)
    handles.length = 0

    await handle.stop()

    expect(store.getSession('ses_resume_e2e_stop')).toBeUndefined()
    expect(store.verifyViewer('ses_resume_e2e_stop', crashed.viewer_token)).toBe(false)
    expect(store.getSessionByViewerToken(crashed.viewer_token)).toBeUndefined()
    expect(() => store.activate(crashed.access_code, 'ses_resume_e2e_stop')).toThrow()
    // And the code is off this machine's disk with the rest of the state.
    expect(loadSessionState('ses_resume_e2e_stop')).toBeUndefined()

    // Sharing again is a new share with a new code, as it has always been.
    const again = await start('ses_resume_e2e_stop')
    expect(again.access_code).not.toBe(crashed.access_code)
    expect(store.verifyViewer('ses_resume_e2e_stop', crashed.viewer_token)).toBe(false)
  },
  30_000,
)

/**
 * A state file recorded against another relay says nothing here: its code was
 * minted elsewhere, and sending it to this relay would hand that relay a
 * credential of a share on another one — the very leak the owner key is bound
 * to an origin to prevent. The earlier share is ended on ITS relay, the way it
 * always was, and this start is an ordinary new share.
 *
 * "Another relay" is spelled here as the same listener under another origin
 * (`localhost` rather than `127.0.0.1`), so the earlier share can still be
 * ended and the start gets as far as registering; what decides is the origin
 * the state recorded, exactly as it decides where that token may be sent.
 */
test.skipIf(process.platform === 'win32')(
  'a code recorded against another relay is never presented to this one',
  async () => {
    const crashed = await crashedShare('ses_resume_otherrelay')
    const otherOrigin = relayUrl.replace('127.0.0.1', 'localhost')
    expect(otherOrigin).not.toBe(relayUrl)
    saveSessionState({ ...crashed.state, relay: otherOrigin })

    const handle = await start('ses_resume_otherrelay')
    expect(handle.access_code).not.toBe(crashed.access_code)
    expect(store.verifyViewer('ses_resume_otherrelay', crashed.viewer_token)).toBe(false)
  },
  30_000,
)

/**
 * A start that fails at its own bridge dial deletes the registration it just
 * made, so nothing is left orphaned — but not when that registration CONTINUED
 * a share that was already up. Deleting that one would end the very viewers
 * this path exists to keep, over a failure that is the bridge's and not
 * theirs. It is left registered for the retry, with the state file naming its
 * live token so `stop` can still end it outright, and the relay's unbound
 * reaper is the backstop if nobody comes back.
 */
test.skipIf(process.platform === 'win32')(
  'a start that fails at the bridge dial does not take a resumed share down with it',
  async () => {
    const crashed = await crashedShare('ses_resume_wsfail')
    // The dial is refused: the relay answers the upgrade with a 404.
    const refuse = (_req: unknown, socket: { destroy(): void; write(s: string): void }) => {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
    }
    const upgrades = relay.listeners('upgrade')
    relay.removeAllListeners('upgrade')
    relay.on('upgrade', refuse as never)
    try {
      await expect(startBridge(relayUrl, undefined, { opencodeUrl, sessionId: 'ses_resume_wsfail' })).rejects.toThrow()
    } finally {
      relay.removeAllListeners('upgrade')
      for (const listener of upgrades) relay.on('upgrade', listener as never)
    }

    // The share is still there with its viewers and its code, and the state
    // file holds the token that ends it.
    expect(store.getSession('ses_resume_wsfail')).toBeDefined()
    expect(store.verifyViewer('ses_resume_wsfail', crashed.viewer_token)).toBe(true)
    const state = loadSessionState('ses_resume_wsfail')
    expect(state?.access_code).toBe(crashed.access_code)
    expect(state?.bridge_token).not.toBe(crashed.bridge_token)
    // ...and says outright that its pid is no bridge, so the retry below is
    // not refused as "already shared from this machine" by a pid that is this
    // very process.
    expect(state?.bridge_gone).toBe(true)

    // The retry the owner makes next resumes it again, code and viewers intact.
    const handle = await start('ses_resume_wsfail')
    expect(handle.access_code).toBe(crashed.access_code)
    expect(store.verifyViewer('ses_resume_wsfail', crashed.viewer_token)).toBe(true)
  },
  30_000,
)

/**
 * Nothing this machine records is a licence to take a share back: a share
 * registered by an install whose owner key this one does not have (another
 * machine, another HOME) is refused by the relay, and the start falls back to
 * ending the earlier share with its own token and registering cleanly — with a
 * new code, because the share it presented the code for is gone.
 */
test.skipIf(process.platform === 'win32')(
  "a share this install cannot prove is settled the old way, not resumed",
  async () => {
    const id = 'ses_resume_foreign'
    const session = await new RelayClient(relayUrl).createSession(id, root, 'foreign', 'x'.repeat(43))
    const { viewer_token } = store.activate(session.access_code, id)
    saveSessionState({
      session_id: id,
      access_code: session.access_code,
      bridge_token: session.bridge_token,
      relay: relayUrl,
      started_at: Date.now(),
      pid: await exitedPid(),
    })

    const handle = await start(id)
    expect(handle.access_code).not.toBe(session.access_code)
    expect(store.verifyViewer(id, viewer_token)).toBe(false)
    expect(await new RelayClient(relayUrl).deleteSession(id, session.bridge_token)).toBe(404)
  },
  30_000,
)
