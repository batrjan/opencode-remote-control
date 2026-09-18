import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * One share's bridge must not be able to make the relay forget another share's
 * subagents.
 *
 * The live event filter lets a subagent's events through only while the relay
 * remembers that session as a subagent of the share, and it learns one from the
 * child's session.created on the share's own event stream. That memory was ONE
 * least-recently-used set of 10,000 entries for every registration on the
 * relay, and anyone may register a share and connect a "bridge" of their own.
 * Such a bridge emitting 10,050 session.created events whose parent is its own
 * share pushed every other share's learned subagents out of the set. The
 * filter never walks a parent chain (it must decide each event at once), so a
 * victim's subagent that was already working then had its permission request
 * dropped: the parent sat waiting on a prompt no viewer could see until they
 * reloaded the page.
 *
 * Harness: createApp + BridgeClient on one ephemeral server, raw ws clients as
 * both bridges, fetch streams as both viewers.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

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
  for (const ac of streams.splice(0)) ac.abort()
  for (const ws of sockets.splice(0)) ws.terminate()
  bridge.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

/** A registered share with its bridge connected and one viewer activated. */
async function share(session_id: string, ip: string) {
  const res = await fetch(`http://${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ session_id, directory: '/w', title: 't' }),
  })
  expect(res.status).toBe(201)
  const { access_code, bridge_token } = (await res.json()) as { access_code: string; bridge_token: string }
  const ws = new WebSocket(`ws://${base}/bridge?session_id=${encodeURIComponent(session_id)}`, {
    headers: { 'x-bridge-token': bridge_token },
  })
  sockets.push(ws)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const { viewer_token } = store.activate(access_code, session_id)
  return {
    emit: (event: unknown) => ws.send(JSON.stringify({ type: 'event', data: JSON.stringify(event) })),
    viewer_token,
  }
}

/**
 * A viewer's /event stream. Keeps the id of every permission.asked it receives
 * and resolves `until(sessionID)` once a session.idle for that session arrived:
 * the same bridge sends it last, so everything before it has been filtered.
 */
async function openStream(viewerToken: string) {
  const ac = new AbortController()
  streams.push(ac)
  const res = await fetch(`http://${base}/event`, { headers: { 'x-viewer-token': viewerToken }, signal: ac.signal })
  expect(res.status).toBe(200)
  const permissions: string[] = []
  const idle = new Set<string>()
  let wake = () => {}
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
          const event = JSON.parse(data) as { type: string; properties?: Record<string, any> }
          if (event.type === 'permission.asked') permissions.push(event.properties!.id)
          if (event.type === 'session.idle') idle.add(event.properties!.sessionID)
        }
        wake()
      }
    } catch {
      // aborted
    }
  })()
  const until = async (sessionID: string) => {
    const deadline = Date.now() + 10_000
    while (!idle.has(sessionID) && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        wake = resolve
        setTimeout(resolve, 50)
      })
    }
    expect(idle.has(sessionID)).toBe(true)
    idle.delete(sessionID)
  }
  return { permissions, until }
}

test("another share's bridge announcing thousands of subagents does not drop this share's subagent prompts", async () => {
  const VICTIM = 'ses_floodVictim1'
  const CHILD = 'ses_floodVictimChild1'
  const ATTACKER = 'ses_floodAttacker1'

  const victim = await share(VICTIM, '198.51.100.7')
  const victimStream = await openStream(victim.viewer_token)
  const attacker = await share(ATTACKER, '203.0.113.66')
  const attackerStream = await openStream(attacker.viewer_token)
  await new Promise((resolve) => setTimeout(resolve, 100))

  // The victim's subagent is learned from its session.created and its prompt
  // reaches the viewer.
  victim.emit({ type: 'session.created', properties: { info: { id: CHILD, parentID: VICTIM } } })
  victim.emit({ type: 'permission.asked', properties: { id: 'per_before', sessionID: CHILD } })
  victim.emit({ type: 'session.idle', properties: { sessionID: VICTIM } })
  await victimStream.until(VICTIM)
  expect(victimStream.permissions).toEqual(['per_before'])

  // Another share's bridge announces more subagents of its own share than the
  // old shared cache held in total.
  const junk = 10_050
  for (let i = 0; i < junk; i++) {
    attacker.emit({ type: 'session.created', properties: { info: { id: `ses_junk${i}`, parentID: ATTACKER } } })
  }
  attacker.emit({ type: 'permission.asked', properties: { id: 'per_attacker_latest', sessionID: `ses_junk${junk - 1}` } })
  attacker.emit({ type: 'session.idle', properties: { sessionID: ATTACKER } })
  await attackerStream.until(ATTACKER)
  // Its own most recent subagent is still known to its own share.
  expect(attackerStream.permissions).toEqual(['per_attacker_latest'])

  // The victim's subagent, still working, asks again: the viewer must see it.
  victim.emit({ type: 'permission.asked', properties: { id: 'per_after', sessionID: CHILD } })
  victim.emit({ type: 'session.idle', properties: { sessionID: VICTIM } })
  await victimStream.until(VICTIM)
  expect(victimStream.permissions).toEqual(['per_before', 'per_after'])
}, 30_000)
