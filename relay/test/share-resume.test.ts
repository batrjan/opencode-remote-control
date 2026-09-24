import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'
import { config } from '../src/config'

/**
 * A share that comes back must not lock out the people already in it.
 *
 * The owner's opencode dies (SIGKILL, a panic, a reboot) or the owner simply
 * starts the share again. Every registration used to mint a fresh access code
 * and revoke every viewer token of the id, so:
 *  - the tab a viewer was holding was sent back to the code-entry page, with a
 *    code that no longer existed — and the viewer is typically somewhere else
 *    entirely, with no way to be told the new one;
 *  - the code the owner had already handed out stopped working, and the new
 *    one exists only in the owner's bridge.log on the owner's machine, which
 *    is exactly the machine that just crashed.
 *
 * A registration that proves the same install (owner_key) AND presents the
 * code the relay already holds for that id now CONTINUES the share instead of
 * replacing it: same code, same viewers. Everything else is unchanged — a new
 * bridge_token is minted, the old bridge socket is dropped, and a registration
 * that cannot show the code still replaces the share the way it always did.
 *
 * What still ends access: `/remote-control/stop` (DELETE), the reaper, and the
 * relay forgetting the session for any other reason. Those are checked here
 * too, because "stopped" has to keep meaning stopped.
 *
 * Harness: createApp + BridgeClient over one ephemeral http server, exactly
 * what startServer wires, with a real ws client as the bridge.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

const OWNER_IP = '198.51.100.7'
const ATTACKER_IP = '203.0.113.66'

let server: http.Server
let store: Store
let bridge: BridgeClient
let base: string
const sockets: WebSocket[] = []

async function listen(s: Store) {
  store = s
  server = http.createServer()
  bridge = new BridgeClient(server, store)
  server.on('request', createApp(store, bridge))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function close() {
  for (const ws of sockets.splice(0)) ws.terminate()
  bridge.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

beforeEach(() => listen(new Store()))
afterEach(async () => {
  vi.restoreAllMocks()
  await close()
})

function ownerKey(): string {
  return randomBytes(32).toString('base64url')
}

interface Registration {
  status: number
  body: { access_code?: string; bridge_token?: string; error?: string; [k: string]: unknown }
}

async function register(
  session_id: string,
  ip: string,
  owner_key?: unknown,
  access_code?: unknown,
): Promise<Registration> {
  const res = await fetch(`http://${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({
      session_id,
      directory: '/owner/project',
      title: 't',
      ...(owner_key === undefined ? {} : { owner_key }),
      ...(access_code === undefined ? {} : { access_code }),
    }),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Registration['body'] }
}

async function remove(session_id: string, token: string): Promise<number> {
  const res = await fetch(`http://${base}/api/sessions/${encodeURIComponent(session_id)}`, {
    method: 'DELETE',
    headers: { 'x-bridge-token': token },
  })
  return res.status
}

function connect(session_id: string, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${base}/bridge?session_id=${encodeURIComponent(session_id)}`, {
    headers: { 'x-bridge-token': token },
  })
  sockets.push(ws)
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

/** A live share with a bridge socket and one viewer already in it. */
async function share(id: string, key: string) {
  const first = await register(id, OWNER_IP, key)
  expect(first.status).toBe(201)
  await connect(id, first.body.bridge_token!)
  const { viewer_token } = store.activate(first.body.access_code!, id)
  expect(store.verifyViewer(id, viewer_token)).toBe(true)
  return { code: first.body.access_code!, token: first.body.bridge_token!, viewer_token }
}

test('a crashed share started again keeps the viewers in and the code alive', async () => {
  const K = ownerKey()
  const { code, token, viewer_token } = await share('ses_resume1', K)

  // The owner's opencode was SIGKILLed; the bridge never told the relay. The
  // new start presents the same owner key and the code its state file holds.
  const again = await register('ses_resume1', OWNER_IP, K, code)
  expect(again.status).toBe(201)
  // The code the owner already handed out is the code that comes back.
  expect(again.body.access_code).toBe(code)
  // The tab a viewer is holding — the one thing nobody can recover remotely.
  expect(store.verifyViewer('ses_resume1', viewer_token)).toBe(true)
  expect(store.getSessionByViewerToken(viewer_token)?.id).toBe('ses_resume1')
  // And somebody who was given the code but has not joined yet still can.
  const late = store.activate(code, 'ses_resume1')
  expect(store.verifyViewer('ses_resume1', late.viewer_token)).toBe(true)

  // The dead bridge's credential is gone all the same: a new one is minted,
  // and the old one owns nothing.
  expect(again.body.bridge_token).not.toBe(token)
  expect(await remove('ses_resume1', token)).toBe(404)
  await connect('ses_resume1', again.body.bridge_token!)
  expect(bridge.isConnected('ses_resume1')).toBe(true)
  expect(store.sessionCount()).toBe(1)
})

test('stop still revokes everything, code and viewers alike', async () => {
  const K = ownerKey()
  const { code, token, viewer_token } = await share('ses_resume_stop', K)
  const resumed = await register('ses_resume_stop', OWNER_IP, K, code)
  expect(resumed.body.access_code).toBe(code)

  expect(await remove('ses_resume_stop', resumed.body.bridge_token!)).toBe(204)
  expect(store.getSession('ses_resume_stop')).toBeUndefined()
  expect(store.verifyViewer('ses_resume_stop', viewer_token)).toBe(false)
  expect(store.getSessionByViewerToken(viewer_token)).toBeUndefined()
  // The code dies with the share: presenting it again registers a NEW share
  // (the id is still the owner's), and the code that comes back is not the
  // one that was stopped.
  expect(() => store.activate(code, 'ses_resume_stop')).toThrow()
  const after = await register('ses_resume_stop', OWNER_IP, K, code)
  expect(after.status).toBe(201)
  expect(after.body.access_code).not.toBe(code)
  expect(store.verifyViewer('ses_resume_stop', viewer_token)).toBe(false)
  // The first bridge_token died with the resume, as it always has.
  expect(await remove('ses_resume_stop', token)).toBe(404)
})

test('a registration that cannot show the code replaces the share, as it always did', async () => {
  const K = ownerKey()
  const { code, viewer_token } = await share('ses_resume_norecall', K)

  // No code at all: the owner's install lost its state file, or an older
  // bridge that does not send one.
  const again = await register('ses_resume_norecall', OWNER_IP, K)
  expect(again.status).toBe(201)
  expect(again.body.access_code).not.toBe(code)
  expect(store.verifyViewer('ses_resume_norecall', viewer_token)).toBe(false)
  expect(() => store.activate(code, 'ses_resume_norecall')).toThrow()
})

test('a code that is not this share\'s does not resume it', async () => {
  const K = ownerKey()
  const { code, viewer_token } = await share('ses_resume_wrong', K)

  // A stale state file, from a share of this id that ended long ago.
  const again = await register('ses_resume_wrong', OWNER_IP, K, 'ZZZZZZ')
  expect(again.status).toBe(201)
  expect(again.body.access_code).not.toBe(code)
  expect(again.body.access_code).not.toBe('ZZZZZZ')
  expect(store.verifyViewer('ses_resume_wrong', viewer_token)).toBe(false)
})

test('a stranger cannot resume a share by presenting a code they were given', async () => {
  const K = ownerKey()
  const { code, viewer_token } = await share('ses_resume_stranger', K)

  // Somebody the owner gave the code to holds the id and the code, and knows
  // the registration endpoint is public. Neither a missing nor a foreign owner
  // key opens it, and the code is never even looked at: the share is untouched.
  for (const key of [undefined, ownerKey()]) {
    const squat = await register('ses_resume_stranger', ATTACKER_IP, key, code)
    expect(squat).toEqual({ status: 409, body: { error: 'session exists' } })
  }
  expect(store.verifyViewer('ses_resume_stranger', viewer_token)).toBe(true)
  expect(store.activate(code, 'ses_resume_stranger').viewer_token).toBeTruthy()
})

/**
 * The relay stores only a salted hash of the code, so it can RECOGNISE a code
 * and never restore one. A session it no longer holds — reaped, evicted,
 * dropped as idle on restore, or on a relay that never had it — has nothing to
 * recognise the presented code against, and taking the bridge's word for it
 * would let a caller pin a code of its own choosing (its length and alphabet
 * are the relay's policy, not the bridge's). So that registration is an
 * ordinary new share with a new code, whatever it presents — the viewers are
 * gone with the session anyway.
 */
test('a code for a session the relay has forgotten is not restored', async () => {
  const K = ownerKey()
  const { code, viewer_token } = await share('ses_resume_reaped', K)

  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + config.orphanReapMs + 60_000)
  expect(store.reapOrphans(config.orphanReapMs)).toEqual(['ses_resume_reaped'])
  vi.restoreAllMocks()

  // The id is still reserved for the install that shared it...
  expect((await register('ses_resume_reaped', ATTACKER_IP, ownerKey(), code)).status).toBe(409)
  // ...and the owner gets it back, with a code of the relay's minting.
  const again = await register('ses_resume_reaped', OWNER_IP, K, code)
  expect(again.status).toBe(201)
  expect(again.body.access_code).not.toBe(code)
  expect(again.body.access_code).toMatch(/^[A-Z0-9]{6}$/)
  expect(store.verifyViewer('ses_resume_reaped', viewer_token)).toBe(false)
})

/**
 * A code the relay cannot read is a code it cannot recognise. A share restored
 * from a PLAINTEXT state file has had its code hash stripped on the way out
 * (FileStateStore), so nothing presented can match it — the share is replaced
 * with a fresh code rather than resumed, and no empty-hash comparison is ever
 * allowed to succeed.
 */
test('a share whose code hash did not survive the state file is replaced, never resumed', async () => {
  const K = ownerKey()
  const { code, viewer_token } = await share('ses_resume_stripped', K)
  const session = store.getSession('ses_resume_stripped')!
  session.code_hash = ''
  session.code_salt = ''

  const again = await register('ses_resume_stripped', OWNER_IP, K, code)
  expect(again.status).toBe(201)
  expect(again.body.access_code).toMatch(/^[A-Z0-9]{6}$/)
  expect(again.body.access_code).not.toBe(code)
  expect(store.verifyViewer('ses_resume_stripped', viewer_token)).toBe(false)

  // Nor does an empty code match an empty hash, below the route that refuses
  // one: the comparison must never be able to succeed on two blanks.
  const second = store.activate(again.body.access_code!, 'ses_resume_stripped').viewer_token
  const blanked = store.getSession('ses_resume_stripped')!
  blanked.code_hash = ''
  blanked.code_salt = ''
  expect(store.createSession('ses_resume_stripped', '/owner/project', 't', OWNER_IP, K, '').resumed).toBe(false)
  expect(store.verifyViewer('ses_resume_stripped', second)).toBe(false)
})

/**
 * The wrong-code lockout is counted against a CODE, not against a
 * registration. A replacement mints a new code, so the misses under that id
 * were guesses at a code that no longer exists and are cleared; a resume keeps
 * the code, so they are still misses against the code that is still live and
 * must be kept — otherwise restarting the share (which an attacker can provoke
 * simply by waiting for the owner to do it) would hand a grinder its window
 * back for free.
 */
test('a resume keeps the failure lock the live code earned; a replacement clears it', async () => {
  const K = ownerKey()
  const { code } = await share('ses_resume_lock', K)
  for (let i = 0; i < config.sessionFailLockThreshold; i += 1) {
    expect(() => store.activate(`WRONG${i}`, 'ses_resume_lock')).toThrow(/invalid code/)
  }
  expect(() => store.activate(code, 'ses_resume_lock')).toThrow(/rate limited/)

  const resumed = await register('ses_resume_lock', OWNER_IP, K, code)
  expect(resumed.body.access_code).toBe(code)
  expect(() => store.activate(code, 'ses_resume_lock')).toThrow(/rate limited/)

  // The owner's way out is the one it always was: a share with a new code.
  const replaced = await register('ses_resume_lock', OWNER_IP, K)
  expect(replaced.body.access_code).not.toBe(code)
  expect(store.activate(replaced.body.access_code!, 'ses_resume_lock').viewer_token).toBeTruthy()
})

/**
 * Registration is public, so what one request may lodge in memory is bounded,
 * and a field the caller meant to send is never silently ignored: a resume
 * that quietly became a replacement would take the viewers with it without a
 * word. The bound is loose on purpose — the code's length and alphabet are the
 * relay's policy (config.codeAlphabet), and a code minted under a previous one
 * must still be able to resume its share.
 */
test('a malformed access_code is refused, not ignored', async () => {
  const K = ownerKey()
  const { code, viewer_token } = await share('ses_resume_bounds', K)
  for (const bad of [42, '', 'C'.repeat(65), { code }]) {
    const res = await register('ses_resume_bounds', OWNER_IP, K, bad)
    expect(res.status).toBe(400)
  }
  // Nothing was recorded, and the live share is untouched.
  expect(store.verifyViewer('ses_resume_bounds', viewer_token)).toBe(true)
  expect((await register('ses_resume_bounds', OWNER_IP, K, code)).body.access_code).toBe(code)
})

/**
 * The relay normalises a presented code the way `activate` does (case, and the
 * `O`/`I` that the alphabet leaves out), so a code read back from a file
 * somebody retyped still resumes its share — and what comes back is the
 * canonical form, which is what the owner is shown and what the state file
 * keeps.
 */
test('a code is recognised however it was written down', async () => {
  const K = ownerKey()
  const { code, viewer_token } = await share('ses_resume_norm', K)
  const again = await register('ses_resume_norm', OWNER_IP, K, ` ${code.toLowerCase()} `)
  expect(again.body.access_code).toBe(code)
  expect(store.verifyViewer('ses_resume_norm', viewer_token)).toBe(true)
})

/**
 * Resuming is not a way to keep an id past its reservation: outside the claim
 * window a share of that id is a new share to the relay, whoever registers it.
 */
test('a claim that lapsed is not reopened by presenting the old code', async () => {
  const K = ownerKey()
  const { code } = await share('ses_resume_lapsed', K)
  const resumed = await register('ses_resume_lapsed', OWNER_IP, K, code)
  expect(resumed.body.access_code).toBe(code)
  expect(await remove('ses_resume_lapsed', resumed.body.bridge_token!)).toBe(204)

  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + config.ownerClaimTtlMs + 60_000)
  const stranger = await register('ses_resume_lapsed', ATTACKER_IP, ownerKey(), code)
  expect(stranger.status).toBe(201)
  expect(stranger.body.access_code).not.toBe(code)
})
