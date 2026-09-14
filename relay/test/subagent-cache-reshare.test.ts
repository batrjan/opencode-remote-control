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
 * What one registration's bridge proved about subagents must not outlive that
 * registration.
 *
 * The relay remembers every session a bridge showed to descend from the shared
 * one (by a parent walk, or by the child's own session.created on the share's
 * event stream), and a remembered subagent is addressed AS ITSELF: its
 * transcript, its detail, its live events, its pending prompts and status. That
 * memory was keyed on the shared session's id alone. An id is not a secret (it
 * is in the share link), and one never registered with an owner_key, or whose
 * reservation lapsed, goes to whoever registers it first. So:
 *
 *  1. someone registers the free id X and connects a "bridge" of their own that
 *     says session Y (someone else's, id known) is a child of X;
 *  2. they walk Y once (or emit its session.created), then end the share;
 *  3. the owner shares X; their real bridge knows Y as an unrelated root;
 *  4. the owner's viewer asks for /session/Y/message — and the relay, finding
 *     Y remembered under X, sent that path to the OWNER's bridge, which
 *     answered with Y's transcript. Y's live events, its detail, its pending
 *     permission and question and its status reached the viewer the same way.
 *
 * The owner's bridge only guards answers (its sharesTree), never reads, so the
 * relay is the only place this can be held. Harness: createApp + BridgeClient
 * on one ephemeral server, raw ws clients as both bridges.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

const OTHER_IP = '203.0.113.66'
const OWNER_IP = '198.51.100.7'
const OTHER_DIR = '/other/dir'
const OWNER_DIR = '/owner/project'

let server: http.Server
let store: Store
let bridge: BridgeClient
let base: string
const sockets: WebSocket[] = []
const streams: AbortController[] = []

beforeEach(async () => {
  store = new Store()
  server = http.createServer()
  bridge = new BridgeClient(server, store)
  server.on('request', createApp(store, bridge))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const ac of streams.splice(0)) ac.abort()
  for (const ws of sockets.splice(0)) ws.terminate()
  bridge.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

async function register(session_id: string, ip: string, directory: string, owner_key?: string) {
  const res = await fetch(`http://${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ session_id, directory, title: 't', ...(owner_key ? { owner_key } : {}) }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { access_code: string; bridge_token: string }
}

type Answer = { status: number; body: unknown }

/** A bridge that answers each proxied request from `answer` and records its path. */
async function mockBridge(session_id: string, token: string, answer: (pathname: string) => Answer) {
  const ws = new WebSocket(`ws://${base}/bridge?session_id=${encodeURIComponent(session_id)}`, {
    headers: { 'x-bridge-token': token },
  })
  sockets.push(ws)
  const paths: string[] = []
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as { type: string; request_id: string; path: string }
    if (msg.type !== 'proxy') return
    const pathname = new URL(msg.path, 'http://localhost').pathname
    paths.push(pathname)
    const { status, body } = answer(pathname)
    ws.send(
      JSON.stringify({
        type: 'proxy_response',
        request_id: msg.request_id,
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      }),
    )
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return {
    paths,
    emit: (event: unknown) => ws.send(JSON.stringify({ type: 'event', data: JSON.stringify(event) })),
  }
}

/** A viewer's /event stream: every non-heartbeat event it receives, as parsed JSON. */
async function openStream(viewerToken: string) {
  const ac = new AbortController()
  streams.push(ac)
  const res = await fetch(`http://${base}/event`, { headers: { 'x-viewer-token': viewerToken }, signal: ac.signal })
  expect(res.status).toBe(200)
  const received: Array<{ type: string; properties: Record<string, any> }> = []
  const waiters: Array<() => void> = []
  void (async () => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buf += decoder.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const data = buf
            .slice(0, i)
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n')
          buf = buf.slice(i + 2)
          if (!data) continue
          const event = JSON.parse(data)
          if (event.type === 'server.heartbeat' || event.type === 'server.connected') continue
          received.push(event)
          for (const wake of waiters.splice(0)) wake()
        }
      }
    } catch {
      // aborted
    }
  })()
  /** Resolves once an event of `type` arrived (or after 3 s). */
  const until = async (type: string) => {
    const deadline = Date.now() + 3000
    while (!received.some((e) => e.type === type) && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
        setTimeout(resolve, 100)
      })
    }
  }
  return { received, until, close: () => ac.abort() }
}

const detail = (id: string, directory: string, parentID?: string) => ({
  id,
  ...(parentID ? { parentID } : {}),
  directory,
  title: id,
  time: { created: 1, updated: 1 },
})

/**
 * Steps 1-2: a registration of `X` whose bridge claims `Y` as its subagent, by
 * the parent walk or on the event stream; the share then ends by `end`.
 */
async function poison(X: string, Y: string, via: 'walk' | 'event', end: 'delete' | 'reap') {
  const other = await register(X, OTHER_IP, OTHER_DIR)
  const otherBridge = await mockBridge(X, other.bridge_token, (pathname) => {
    if (pathname === `/session/${Y}`) return { status: 200, body: detail(Y, OTHER_DIR, X) }
    if (pathname === `/session/${X}`) return { status: 200, body: detail(X, OTHER_DIR) }
    return { status: 200, body: [] }
  })
  const { viewer_token } = store.activate(other.access_code, X)
  if (via === 'walk') {
    const read = await fetch(`http://${base}/session/${Y}/message`, { headers: { 'x-viewer-token': viewer_token } })
    expect(read.status).toBe(200)
    // The relay took Y for X's subagent, so the path went out under Y.
    expect(otherBridge.paths).toContain(`/session/${Y}/message`)
  } else {
    const stream = await openStream(viewer_token)
    await new Promise((resolve) => setTimeout(resolve, 100))
    otherBridge.emit({ type: 'session.created', properties: { info: detail(Y, OTHER_DIR, X) } })
    await stream.until('session.created')
    expect(stream.received.map((e) => e.properties.info?.id)).toEqual([Y])
    stream.close()
  }
  if (end === 'delete') {
    const res = await fetch(`http://${base}/api/sessions/${X}`, {
      method: 'DELETE',
      headers: { 'x-bridge-token': other.bridge_token },
    })
    expect(res.status).toBe(204)
  } else {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + config.orphanReapMs + 60_000)
    expect(store.reapOrphans(config.orphanReapMs)).toEqual([X])
    bridge.disconnect(X) // what the server's reaper does with each id it removed
    vi.restoreAllMocks()
  }
  expect(store.getSession(X)).toBeUndefined()
}

/**
 * Steps 3-4: the owner shares `X`; their bridge knows `Y` as an unrelated root
 * session with a transcript, a pending permission and question, and a status.
 * Everything the owner's viewer then reads must stay within X.
 */
async function ownerSharesAgain(X: string, Y: string) {
  const owner = await register(X, OWNER_IP, OWNER_DIR, randomBytes(32).toString('base64url'))
  const ownerBridge = await mockBridge(X, owner.bridge_token, (pathname) => {
    switch (pathname) {
      case `/session/${X}`:
        return { status: 200, body: detail(X, OWNER_DIR) }
      case `/session/${Y}`:
        return { status: 200, body: detail(Y, OWNER_DIR) }
      case `/session/${X}/message`:
        return { status: 200, body: [{ info: { id: 'msg_x', sessionID: X }, parts: [{ text: 'transcript of X' }] }] }
      case `/session/${Y}/message`:
        return { status: 200, body: [{ info: { id: 'msg_y', sessionID: Y }, parts: [{ text: 'PRIVATE transcript of Y' }] }] }
      case '/permission':
        return { status: 200, body: [{ id: 'per_x', sessionID: X }, { id: 'per_y', sessionID: Y }] }
      case '/question':
        return { status: 200, body: [{ id: 'que_y', sessionID: Y }] }
      case '/session/status':
        return { status: 200, body: { [X]: { type: 'busy' }, [Y]: { type: 'busy' } } }
      default:
        return { status: 404, body: { error: 'mock: no route' } }
    }
  })
  const { viewer_token } = store.activate(owner.access_code, X)
  const get = async (path: string) => {
    const res = await fetch(`http://${base}${path}`, { headers: { 'x-viewer-token': viewer_token } })
    return { status: res.status, body: (await res.json()) as any }
  }

  const transcript = await get(`/session/${Y}/message`)
  expect(transcript.status).toBe(200)
  expect(JSON.stringify(transcript.body)).not.toContain('PRIVATE transcript of Y')
  expect(transcript.body[0].info.sessionID).toBe(X)
  const sessionDetail = await get(`/session/${Y}`)
  expect(sessionDetail.body.id).toBe(X)
  expect((await get('/permission')).body.map((p: { id: string }) => p.id)).toEqual(['per_x'])
  expect((await get('/question')).body).toEqual([])
  expect((await get('/session/status')).body).toEqual({ [X]: { type: 'busy' } })
  // Nothing addressed Y upstream except the detail reads that prove what it is.
  expect(ownerBridge.paths.filter((p) => p.startsWith(`/session/${Y}`) && p !== `/session/${Y}`)).toEqual([])

  const stream = await openStream(viewer_token)
  await new Promise((resolve) => setTimeout(resolve, 100))
  ownerBridge.emit({ type: 'message.part.updated', properties: { part: { sessionID: Y, text: 'PRIVATE live part of Y' } } })
  ownerBridge.emit({ type: 'permission.asked', properties: { id: 'per_y_live', sessionID: Y } })
  ownerBridge.emit({ type: 'session.idle', properties: { sessionID: X } })
  await stream.until('session.idle')
  expect(stream.received.map((e) => e.type)).toEqual(['session.idle'])
}

test("a subagent one registration's bridge walked stays out of the id's next registration (share deleted)", async () => {
  await poison('ses_reshareWalkX1', 'ses_reshareWalkY1', 'walk', 'delete')
  await ownerSharesAgain('ses_reshareWalkX1', 'ses_reshareWalkY1')
})

test("a subagent announced on one registration's event stream stays out of the next one (share reaped)", async () => {
  await poison('ses_reshareEventX1', 'ses_reshareEventY1', 'event', 'reap')
  await ownerSharesAgain('ses_reshareEventX1', 'ses_reshareEventY1')
})

test("a registration's own subagents still read as themselves", async () => {
  // The fix must not cost the owner what 44bb326 gave them: a proven child is
  // addressed as itself, and a remembered one is not walked again.
  const X = 'ses_reshareOwnX1'
  const CHILD = 'ses_reshareOwnChild1'
  const owner = await register(X, OWNER_IP, OWNER_DIR, randomBytes(32).toString('base64url'))
  const ownerBridge = await mockBridge(X, owner.bridge_token, (pathname) => {
    if (pathname === `/session/${CHILD}`) return { status: 200, body: detail(CHILD, OWNER_DIR, X) }
    if (pathname === `/session/${CHILD}/message`) return { status: 200, body: [{ info: { id: 'msg_c', sessionID: CHILD } }] }
    return { status: 404, body: { error: 'mock: no route' } }
  })
  const { viewer_token } = store.activate(owner.access_code, X)
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`http://${base}/session/${CHILD}/message`, { headers: { 'x-viewer-token': viewer_token } })
    expect(((await res.json()) as any)[0].info.sessionID).toBe(CHILD)
  }
  expect(ownerBridge.paths).toEqual([`/session/${CHILD}`, `/session/${CHILD}/message`, `/session/${CHILD}/message`])
})
