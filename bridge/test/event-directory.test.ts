import { afterEach, beforeEach, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OpencodeClient } from '../src/opencode'
import { startBridge } from '../src/index'

/**
 * opencode filters GET /event by project directory, defaulting to the server's
 * OWN instance directory. The bridge subscribed without one, so whenever the
 * shared session lived somewhere else — the desktop app hosting several
 * projects, or a bridge started from another folder — the stream carried
 * nothing but heartbeats. The answer completed on disk while every viewer sat
 * on "thinking" forever, which is exactly what a share looks like when it
 * hangs.
 */
let opencode: Server
let opencodeUrl: string
let eventQueries: (string | null)[]
let relay: Server
let relayUrl: string

const SESSION_DIR = '/projects/shared-one'

beforeEach(async () => {
  eventQueries = []
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (url.pathname === '/event') {
      eventQueries.push(url.searchParams.get('directory'))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.flushHeaders() // fetch() resolves on headers; the body stays open
      res.write('data: {"type":"server.connected","properties":{}}\n\n')
      return // held open, like the real stream
    }
    if (url.pathname === '/global/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end('{"ok":true}')
    }
    if (url.pathname === '/session/ses_explicit') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ id: 'ses_explicit', directory: SESSION_DIR, title: 'shared' }))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('[]')
  })
  await new Promise<void>((r) => opencode.listen(0, r))
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`

  // Minimal relay: accepts registration and the bridge WS upgrade.
  relay = createServer((req, res) => {
    if (req.url?.startsWith('/api/sessions')) {
      res.writeHead(201, { 'Content-Type': 'application/json' })
      return res.end(
        JSON.stringify({ session_id: 'ses_explicit', access_code: 'ABC123', bridge_token: 't', viewer_url: '/x' }),
      )
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  const { WebSocketServer } = await import('ws')
  const wss = new WebSocketServer({ server: relay, path: '/bridge' })
  wss.on('connection', () => {})
  await new Promise<void>((r) => relay.listen(0, r))
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterEach(async () => {
  // The SSE stream is deliberately held open; without this close() would wait
  // on it forever.
  opencode.closeAllConnections?.()
  relay.closeAllConnections?.()
  await new Promise((r) => opencode.close(r))
  await new Promise((r) => relay.close(r))
})

test('getEvent scopes the stream to the session directory', async () => {
  const client = new OpencodeClient(opencodeUrl, 'opencode', '')
  const stream = await client.getEvent(undefined, SESSION_DIR)
  expect(eventQueries).toEqual([SESSION_DIR])
  await stream?.cancel()
})

test('getEvent without a directory still works (server-local sessions)', async () => {
  const client = new OpencodeClient(opencodeUrl, 'opencode', '')
  const stream = await client.getEvent()
  expect(eventQueries).toEqual([null])
  await stream?.cancel()
})

test('an explicit --session-id subscribes with THAT session directory, not the cwd', async () => {
  const handle = await startBridge(relayUrl, undefined, {
    opencodeUrl,
    sessionId: 'ses_explicit',
    healthIntervalMs: 60_000,
  })
  try {
    // The stream is scoped to the session's own directory — never process.cwd().
    expect(eventQueries).toEqual([SESSION_DIR])
    expect(eventQueries[0]).not.toBe(process.cwd())
  } finally {
    await handle.stop()
  }
}, 20_000)
