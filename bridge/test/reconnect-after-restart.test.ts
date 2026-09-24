import { afterEach, beforeEach, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { startServer } from '../../relay/src/server'
import { opencodeAuthHeader } from '../src/config'
import { OpencodeClient } from '../src/opencode'
import { RelayWSClient } from '../src/relay'

/**
 * The whole point of persisting sessions: when the relay restarts, a bridge
 * that is still running RECONNECTS to its restored session instead of treating
 * the re-dial as fatal and ending the share.
 *
 * Real restart = the relay process exits and a new one starts (fresh listener,
 * same state file). Here relay2 is started first and the bridge is repointed
 * at it, then relay1's socket is dropped — this reproduces the reconnect +
 * restore path without the half-open-port race a same-process restart has.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY

let opencode: Server
let opencodeUrl: string
let dir: string
let file: string

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const port = (s: Server) => (s.address() as AddressInfo).port

beforeEach(async () => {
  process.env.REMOTE_CONTROL_RECONNECT_BASE_MS = '20'
  process.env.REMOTE_CONTROL_RECONNECT_MAX_MS = '80'
  dir = mkdtempSync(path.join(tmpdir(), 'reconnect-'))
  file = path.join(dir, 'state.json')
  process.env.RELAY_STATE_FILE = file
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (req.headers.authorization !== opencodeAuthHeader()) return json(res, 401, { error: 'unauthorized' })
    if (url.pathname === '/global/health') return json(res, 200, { healthy: true })
    if (url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"type":"server.connected","properties":{}}\n\n')
      return
    }
    json(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeUrl = `http://127.0.0.1:${port(opencode)}`
})

afterEach(async () => {
  delete process.env.RELAY_STATE_FILE
  delete process.env.REMOTE_CONTROL_RECONNECT_BASE_MS
  delete process.env.REMOTE_CONTROL_RECONNECT_MAX_MS
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

async function register(relay: Server): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port(relay)}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ session_id: 'ses_reconn', directory: '/w', title: 'live' }),
  })
  return ((await res.json()) as { bridge_token: string }).bridge_token
}

function newClient(relay: Server): RelayWSClient {
  return new RelayWSClient(
    `http://127.0.0.1:${port(relay)}`,
    new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''),
  )
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return cond()
}

test('a running bridge reconnects to its restored session after a relay restart', async () => {
  const relay1 = await startServer(0)
  const bridgeToken = await register(relay1)
  const ws = newClient(relay1)
  let fatal = false
  let reconnects = 0
  ws.onFatal = () => (fatal = true)
  ws.onReconnect = () => (reconnects += 1)
  await ws.connect('ses_reconn', bridgeToken)
  await new Promise((r) => setTimeout(r, 500)) // let the snapshot land

  // A fresh relay process, same state file: it restores the session (same
  // bridge_token hash), so the bridge's re-dial is accepted, not 401'd.
  const relay2 = await startServer(0)
  ;(ws as unknown as { relayUrl: string }).relayUrl = `http://127.0.0.1:${port(relay2)}`
  // The relay process vanished from the bridge's point of view — drop the
  // client socket, exactly what the keep-alive sees on a dead link, so the
  // bridge re-dials (now at relay2).
  ;(ws as unknown as { ws: { terminate(): void } }).ws.terminate()

  try {
    expect(await waitFor(() => reconnects > 0)).toBe(true)
    expect(fatal).toBe(false)
    const presence = await fetch(`http://127.0.0.1:${port(relay2)}/api/sessions/ses_reconn`)
    expect(((await presence.json()) as { bridge_connected: boolean }).bridge_connected).toBe(true)
  } finally {
    ws.close()
    relay1.closeAllConnections()
    relay2.closeAllConnections()
    await new Promise((resolve) => relay1.close(resolve))
    await new Promise((resolve) => relay2.close(resolve))
  }
}, 20_000)

test('a bridge whose session is NOT restored ends the share', async () => {
  const relay1 = await startServer(0)
  const bridgeToken = await register(relay1)
  const ws = newClient(relay1)
  let fatal = false
  ws.onFatal = () => (fatal = true)
  await ws.connect('ses_reconn', bridgeToken)

  // relay2 with a DIFFERENT (empty) state file: the session is gone, so the
  // re-dial is rejected at the upgrade and the share ends instead of looping.
  const emptyDir = mkdtempSync(path.join(tmpdir(), 'reconnect-empty-'))
  process.env.RELAY_STATE_FILE = path.join(emptyDir, 'state.json')
  const relay2 = await startServer(0)
  ;(ws as unknown as { relayUrl: string }).relayUrl = `http://127.0.0.1:${port(relay2)}`
  ;(ws as unknown as { ws: { terminate(): void } }).ws.terminate()

  try {
    expect(await waitFor(() => fatal)).toBe(true)
  } finally {
    ws.close()
    relay1.closeAllConnections()
    relay2.closeAllConnections()
    await new Promise((resolve) => relay1.close(resolve))
    await new Promise((resolve) => relay2.close(resolve))
    rmSync(emptyDir, { recursive: true, force: true })
  }
}, 20_000)
