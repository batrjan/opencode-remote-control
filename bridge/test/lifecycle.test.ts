import { afterAll, beforeAll, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { startServer } from '../../relay/src/server'
import { RelayClient } from '../src/relay'
import { opencodeAuthHeader } from '../src/config'
import { startBridge, stopBridge } from '../src/index'

/**
 * Lifecycle integration test: startBridge registers the session on a real
 * (in-process) relay, connects the WS bridge and forwards events from a mock
 * opencode; stopBridge deletes the session. The watchdog test kills the mock
 * opencode and expects the bridge to shut down and notify the relay.
 *
 * Note: the brief's sketch asserted lowercase codes (`/^[a-z0-9]{6}$/`), but
 * the alphabet ruling (progress ledger) made codes uppercase [A-Z0-9] minus
 * O,I — the assertion below matches the implemented alphabet.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY

let relay: Server
let relayUrl: string
let opencode: Server
let opencodeUrl: string
let opencodeListening = false

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function listenOpencode(): Promise<void> {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    // Enforce the same basic auth as the real server — otherwise the
    // detectOpenCodePort scan in detect.test.ts (parallel worker) would
    // mistake this mock for a healthy opencode.
    if (req.headers.authorization !== opencodeAuthHeader()) {
      return json(res, 401, { error: 'unauthorized' })
    }
    if (url.pathname === '/global/health') return json(res, 200, { healthy: true })
    if (url.pathname === '/session') {
      return json(res, 200, [
        { id: 'sess-lc', directory: '/path', title: 'mock session', time: { created: 1 } },
      ])
    }
    if (url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': connected\n\n')
      return // keep the SSE stream open until the server is torn down
    }
    json(res, 404, { error: 'not found' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeListening = true
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`
}

async function closeOpencode(): Promise<void> {
  if (!opencodeListening) return
  opencodeListening = false
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
}

beforeAll(async () => {
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
  await listenOpencode()
})

afterAll(async () => {
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  await closeOpencode()
})

test('start and stop bridge', async () => {
  const handle = await startBridge(relayUrl, API_KEY, {
    opencodeUrl,
    sessionId: 'sess-lc',
  })
  try {
    expect(handle.session_id).toBe('sess-lc')
    expect(handle.access_code).toMatch(/^[A-Z0-9]{6}$/)
    expect(handle.viewer_url).toBe('/join')
    // The session is registered on the relay.
    const relayClient = new RelayClient(relayUrl, API_KEY)
    expect(await relayClient.getSession('sess-lc')).toBe(200)
  } finally {
    await stopBridge(relayUrl, handle.session_id, API_KEY)
  }
  // stopBridge deleted the relay session.
  expect(await new RelayClient(relayUrl, API_KEY).getSession('sess-lc')).toBe(404)
  // Idempotent: deleting an already-deleted session is not an error.
  await stopBridge(relayUrl, handle.session_id, API_KEY)
  await handle.stop() // releases the WS connection and timers
  await handle.closed
})

test('watchdog stops the bridge and notifies the relay when opencode dies', async () => {
  const handle = await startBridge(relayUrl, API_KEY, {
    opencodeUrl,
    sessionId: 'sess-wd',
    healthIntervalMs: 100,
  })
  expect(await new RelayClient(relayUrl, API_KEY).getSession('sess-wd')).toBe(200)
  await closeOpencode()
  await handle.closed // resolves once a health tick fails
  expect(await new RelayClient(relayUrl, API_KEY).getSession('sess-wd')).toBe(404)
  await listenOpencode() // restore for any later tests / clean teardown
})

test('startBridge rejects a wrong relay api key', async () => {
  await expect(
    startBridge(relayUrl, 'wrong-key', { opencodeUrl, sessionId: 'sess-denied' }),
  ).rejects.toThrow(/401/)
})
