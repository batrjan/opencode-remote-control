import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { viewerTokenFrom } from './helpers/viewer-token'
import { WebSocket } from 'ws'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * The proxy's buffered-bytes budget (see proxy-buffer-cap.test.ts) charged a
 * body BEFORE the send, but registered the 'finish'/'close' listeners that give
 * the budget back AFTER it. A send that threw — and the bridge, which anyone can
 * register, picks both the Content-Type and the status verbatim — skipped the
 * registration entirely, so those bytes were charged forever: no timer and no
 * socket close could return them, only a relay restart. A handful of such
 * requests exhausted the process-wide ceiling and every share's proxied traffic
 * answered 503 'relay busy' from then on.
 *
 * Two independent ways to make the send throw, both exercised here:
 *  - a Content-Type whose media type is allow-listed but which carries a CRLF in
 *    its parameters (res.type() -> setHeader -> ERR_INVALID_CHAR);
 *  - a status outside 100..599 (res.send() -> writeHead ->
 *    ERR_HTTP_INVALID_STATUS_CODE), which no Content-Type fix alone catches.
 * Each request here is read to completion and its socket closed, so a leak is
 * the only thing that can keep the budget pinned.
 */

const KiB = 1024
const MiB = 1024 * 1024

let relay: http.Server
let relayUrl: string
const saved: Record<string, string | undefined> = {}
const ENV = ['RELAY_BRIDGE_MAX_PAYLOAD_BYTES', 'RELAY_PROXY_MAX_BUFFERED_BYTES', 'ACTIVATE_FAIL_DELAY_MS']

beforeEach(async () => {
  for (const key of ENV) saved[key] = process.env[key]
  process.env.ACTIVATE_FAIL_DELAY_MS = '0'
  process.env.RELAY_BRIDGE_MAX_PAYLOAD_BYTES = String(MiB)
  // A 1 MiB ceiling against 512 KiB bodies: two leaked sends exhaust it.
  process.env.RELAY_PROXY_MAX_BUFFERED_BYTES = String(MiB)
  const store = new Store()
  relay = http.createServer()
  const bridge = new BridgeClient(relay, store)
  relay.on('request', createApp(store, bridge))
  relay.on('close', () => bridge.close())
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterEach(async () => {
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

/** Register a share and join it once; returns the tokens. */
async function share(id: string) {
  const created = await request(relay).post('/api/sessions').send({ session_id: id, directory: '/work', title: 't' })
  expect(created.status).toBe(201)
  const { access_code, bridge_token } = created.body as { access_code: string; bridge_token: string }
  const act = await request(relay).post('/api/activate').send({ code: access_code, session_id: id })
  return { viewerToken: viewerTokenFrom(act), bridgeToken: bridge_token }
}

/**
 * A hostile bridge: it answers every proxy request with a 512 KiB body and
 * whatever status / Content-Type the test currently asks for, so the same socket
 * can serve the poisoned responses and then an honest one.
 */
async function hostileBridge(id: string, token: string) {
  const ws = new WebSocket(`${relayUrl.replace(/^http/, 'ws')}/bridge?session_id=${id}`, {
    headers: { 'x-bridge-token': token },
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const body = 'a'.repeat(512 * KiB)
  const answer = { status: 200, contentType: 'text/plain' as string | undefined }
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return
    let msg: { type?: string; request_id?: string }
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (msg.type === 'proxy' && typeof msg.request_id === 'string') {
      ws.send(
        JSON.stringify({
          type: 'proxy_response',
          request_id: msg.request_id,
          status: answer.status,
          contentType: answer.contentType,
          body,
        }),
      )
    }
  })
  return { ws, answer }
}

/**
 * Two poisoned requests, then an honest one. The honest request must be served:
 * whether the relay defuses the poison (200) or the send still fails (502), the
 * bytes it charged are owed back to the budget either way.
 */
async function budgetSurvives(id: string, poison: { status?: number; contentType?: string }) {
  const { viewerToken, bridgeToken } = await share(id)
  const bridge = await hostileBridge(id, bridgeToken)
  try {
    if (poison.status !== undefined) bridge.answer.status = poison.status
    if (poison.contentType !== undefined) bridge.answer.contentType = poison.contentType
    for (let i = 0; i < 2; i++) {
      // supertest reads the whole response and closes the socket, so nothing is
      // parked: only a leak can keep these bytes charged.
      const attack = await request(relay).get('/agent').set('x-viewer-token', viewerToken)
      expect([200, 502]).toContain(attack.status)
    }
    bridge.answer.status = 200
    bridge.answer.contentType = 'text/plain'
    const honest = await request(relay).get('/agent').set('x-viewer-token', viewerToken)
    // On HEAD this is 503 'relay busy' — the budget never came back.
    expect(honest.status).toBe(200)
    expect(honest.text.length).toBe(512 * KiB)
  } finally {
    bridge.ws.terminate()
  }
}

test('a Content-Type the send rejects does not strand the proxy budget', async () => {
  await budgetSurvives('ses_leak_ctype', { contentType: 'application/json; charset=utf-8\r\nX-Injected: 1' })
}, 20_000)

test('a status the send rejects does not strand the proxy budget', async () => {
  await budgetSurvives('ses_leak_status', { status: 99 })
}, 20_000)

test('a Content-Type outside the header grammar is relabelled, not sent verbatim', async () => {
  const id = 'ses_ctype_grammar'
  const { viewerToken, bridgeToken } = await share(id)
  const bridge = await hostileBridge(id, bridgeToken)
  try {
    // Allow-listed media type, but the parameters are not a header value the
    // relay is willing to repeat: it falls back to octet-stream instead.
    bridge.answer.contentType = 'application/json; charset=utf-8\r\nX-Injected: 1'
    const res = await request(relay).get('/agent').set('x-viewer-token', viewerToken)
    expect(res.status).toBe(200)
    // express appends its own charset to a string body, hence the prefix match.
    expect(res.headers['content-type']).toMatch(/^application\/octet-stream/)
    expect(res.headers['x-injected']).toBeUndefined()
    // An ordinary parameterised type still goes out as the bridge meant it
    // (express re-serialises the parameters, hence the loose match).
    bridge.answer.contentType = 'text/plain;charset=UTF-8'
    const ok = await request(relay).get('/agent').set('x-viewer-token', viewerToken)
    expect(ok.status).toBe(200)
    expect(ok.headers['content-type']).toMatch(/^text\/plain;\s*charset=utf-8$/i)
  } finally {
    bridge.ws.terminate()
  }
}, 20_000)
