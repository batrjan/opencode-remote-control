import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import net, { type AddressInfo, type Socket } from 'node:net'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import { opencodeAuthHeader } from '../src/config'
import { OpencodeClient } from '../src/opencode'
import { RelayWSClient } from '../src/relay'

/**
 * A re-dial that is never answered must not end the share.
 *
 * Nothing watched a relay socket that had not opened yet: keep-alive starts at
 * 'open', ws has no handshake deadline unless asked for one, and the next
 * attempt was only scheduled once the current one failed. When the bridge's
 * bytes were delivered but no answer ever came back — the laptop slept or
 * switched networks right after the request left, a NAT entry expired, a
 * captive portal or transparent proxy held :443 open and said nothing, nginx
 * accepted the upgrade and waited on an upstream (proxy_read_timeout is a day)
 * — the socket sat in CONNECTING for good. The keep-alive even walked into it
 * on its own: it noticed a dead network, terminated, and re-dialled straight
 * into the path that was still dead. The process stayed alive, opencode
 * events were dropped because no socket was open, viewers saw a share that
 * never came back, and the log said nothing.
 *
 * The handshake now has a deadline, so a stalled attempt fails like any other
 * transport error and the backoff loop carries on.
 */

const HANDSHAKE_TIMEOUT_MS = 300
const PING_INTERVAL_MS = '100'
process.env.REMOTE_CONTROL_WS_PING_INTERVAL_MS = PING_INTERVAL_MS
process.env.REMOTE_CONTROL_RECONNECT_BASE_MS = '30'
process.env.REMOTE_CONTROL_RECONNECT_MAX_MS = '120'
process.env.REMOTE_CONTROL_EVENT_RETRY_MS = '40'
process.env.REMOTE_CONTROL_WS_HANDSHAKE_TIMEOUT_MS = String(HANDSHAKE_TIMEOUT_MS)

let opencode: Server
let opencodeUrl: string

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (req.headers.authorization !== opencodeAuthHeader()) return void res.writeHead(401).end()
    if (url.pathname === '/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"type":"server.connected","properties":{}}\n\n')
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`
})

afterAll(async () => {
  opencode.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(20)
  }
  return predicate()
}

/**
 * Stand-in relay whose /bridge upgrade can be switched to "stall": the TCP
 * connection is accepted and the HTTP upgrade request read, but never answered.
 */
async function stallableRelay() {
  const wss = new WebSocketServer({ noServer: true })
  const relay = {
    url: '',
    stall: false,
    upgrades: 0,
    /** Server ends of upgrades left unanswered, and how many the bridge gave up on. */
    stalled: [] as Socket[],
    stalledClosed: 0,
    live: [] as WsSocket[],
    close: async () => {},
  }
  const server = createServer((_req, res) => res.writeHead(404).end())
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    relay.upgrades += 1
    if (relay.stall) {
      relay.stalled.push(socket)
      socket.on('error', () => {})
      // The upgrade hands over a paused socket on a half-open-allowing server:
      // read it, or the bridge hanging up surfaces as neither 'end' nor 'close'.
      let gone = false
      const hungUp = () => {
        if (gone) return
        gone = true
        relay.stalledClosed += 1
      }
      socket.on('end', hungUp)
      socket.on('close', hungUp)
      socket.resume()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => relay.live.push(ws))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  relay.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  relay.close = async () => {
    for (const s of relay.stalled) s.destroy()
    for (const ws of relay.live) ws.terminate()
    wss.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  return relay
}

/** Accepts TCP and never sends a byte — a wss:// dial's ClientHello goes unanswered. */
async function silentTcpServer() {
  const held: Socket[] = []
  const tcp = {
    port: 0,
    accepted: 0,
    close: async () => {},
  }
  const server = net.createServer((socket) => {
    tcp.accepted += 1
    held.push(socket)
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  tcp.port = (server.address() as AddressInfo).port
  tcp.close = async () => {
    for (const s of held) s.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
  return tcp
}

function bridge(relayUrl: string) {
  const ws = new RelayWSClient(relayUrl, new OpencodeClient(opencodeUrl, 'opencode', process.env.OPENCODE_SERVER_PASSWORD ?? ''))
  const counts = { reconnects: 0 }
  ws.onReconnect = () => {
    counts.reconnects += 1
  }
  return { ws, counts }
}

test('a re-dial whose upgrade is never answered is given up and retried', async () => {
  const relay = await stallableRelay()
  const { ws, counts } = bridge(relay.url)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await ws.connect('ses_stalled_upgrade', 'token')
    relay.stall = true
    relay.live[0]!.terminate()
    expect(await waitFor(() => relay.stalled.length >= 1)).toBe(true)
    // Silent for longer than the handshake timeout, then the path works again.
    await sleep(HANDSHAKE_TIMEOUT_MS * 2)
    relay.stall = false

    // A live retry loop dials ~25 more times in this window; before the fix it
    // never dialled again and the socket stayed CONNECTING.
    const reconnected = await waitFor(() => counts.reconnects >= 1)
    const state = (ws as unknown as { ws: { readyState: number } | null }).ws?.readyState
    expect(reconnected, `upgrades=${relay.upgrades}, bridge socket readyState=${state}`).toBe(true)
    expect(relay.upgrades).toBeGreaterThan(relay.stalled.length)
    // The stalled attempt was abandoned by the bridge, not left hanging.
    expect(relay.stalledClosed).toBeGreaterThanOrEqual(1)
    // And the failure is visible in the log.
    expect(warn.mock.calls.some(([line]) => /re-dial.*handshake has timed out/i.test(String(line)))).toBe(true)
  } finally {
    warn.mockRestore()
    ws.close()
    await relay.close()
  }
}, 15_000)

test('a re-dial whose TLS handshake is never answered is given up and retried', async () => {
  const relay = await stallableRelay()
  const silent = await silentTcpServer()
  const { ws, counts } = bridge(relay.url)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await ws.connect('ses_stalled_tls', 'token')
    // The next dial goes to a wss:// endpoint that accepts TCP and then says nothing.
    ws.relayUrl = `https://127.0.0.1:${silent.port}`
    relay.live[0]!.terminate()
    expect(await waitFor(() => silent.accepted >= 1)).toBe(true)
    expect(await waitFor(() => silent.accepted >= 2), `TLS dials=${silent.accepted}`).toBe(true)
    ws.relayUrl = relay.url
    expect(await waitFor(() => counts.reconnects >= 1)).toBe(true)
  } finally {
    warn.mockRestore()
    ws.close()
    await silent.close()
    await relay.close()
  }
}, 15_000)

test('the first connect() to a relay that never answers fails instead of hanging', async () => {
  // startBridge awaits this before printing the code; hanging here left the
  // plugin reporting a timeout while the detached bridge lived on.
  const relay = await stallableRelay()
  relay.stall = true
  const { ws } = bridge(relay.url)
  try {
    const outcome = await Promise.race([
      ws.connect('ses_first_dial', 'token').then(
        () => 'opened',
        (err: Error) => err.message,
      ),
      sleep(3000).then(() => 'still pending after 3 s'),
    ])
    expect(outcome).toMatch(/handshake has timed out/i)
    expect(await waitFor(() => relay.stalledClosed === 1)).toBe(true)
  } finally {
    ws.close()
    await relay.close()
  }
}, 15_000)

test('an open link that stays quiet for longer than the handshake timeout is kept', async () => {
  // The deadline covers the handshake only. No keep-alive pings here, so the
  // socket is idle well past it: an open link must not be torn down for that.
  process.env.REMOTE_CONTROL_WS_PING_INTERVAL_MS = '60000'
  const relay = await stallableRelay()
  const { ws, counts } = bridge(relay.url)
  try {
    await ws.connect('ses_quiet_link', 'token')
    await sleep(HANDSHAKE_TIMEOUT_MS * 4)
    expect(relay.upgrades).toBe(1)
    expect(relay.live[0]!.readyState).toBe(1)
    expect(counts.reconnects).toBe(0)
  } finally {
    process.env.REMOTE_CONTROL_WS_PING_INTERVAL_MS = PING_INTERVAL_MS
    ws.close()
    await relay.close()
  }
}, 15_000)
