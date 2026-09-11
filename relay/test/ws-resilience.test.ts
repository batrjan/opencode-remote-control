import { afterEach, beforeEach, expect, test } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { WebSocket } from 'ws'
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * The relay must survive a hostile bridge socket.
 *
 * `ws` emits 'error' on a protocol violation, and an 'error' event with no
 * listener is rethrown by EventEmitter — which takes the whole Node process
 * down. Registration is public, so ANY visitor could register a session, dial
 * /bridge with the credentials they were just handed, send three malformed
 * bytes, and end every other live share on the relay. These tests pin the
 * per-socket 'error' handler that confines the violation to its own socket.
 */

let server: http.Server
let store: Store
let bridge: BridgeClient
let port: number

beforeEach(async () => {
  store = new Store()
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  bridge = new BridgeClient(server, store)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  bridge.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

/** Does the relay still answer HTTP? The process being alive is the assertion. */
function stillServing(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(3000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * Speak the WebSocket handshake by hand so the frames afterwards can be
 * illegal — a compliant client library would refuse to send them.
 */
function rawUpgrade(session_id: string, token: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET /bridge?session_id=${encodeURIComponent(session_id)} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          `x-bridge-token: ${token}\r\n\r\n`,
      )
    })
    socket.once('error', reject)
    socket.once('data', (chunk) => {
      const head = chunk.toString('latin1')
      if (!head.startsWith('HTTP/1.1 101')) return reject(new Error(`upgrade refused: ${head.split('\r\n')[0]}`))
      const accept = createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64')
      if (!head.includes(accept)) return reject(new Error('bad Sec-WebSocket-Accept'))
      resolve(socket)
    })
  })
}

function registerBridgeSession(id: string) {
  const { bridge_token } = store.createSession(id, '/work', 'title', '203.0.113.7')
  return bridge_token
}

test('every accepted bridge socket carries an error listener', async () => {
  // The direct assertion, because the black-box tests below CANNOT fail here:
  // vitest installs its own uncaughtException handler, so an unhandled 'error'
  // shows up as a reported error rather than the process death it is in
  // production. This checks the actual invariant — a socket with no 'error'
  // listener is one malformed frame away from ending the relay.
  const token = registerBridgeSession('ses_listener')
  const client = new WebSocket(`ws://127.0.0.1:${port}/bridge?session_id=ses_listener`, {
    headers: { 'x-bridge-token': token },
  })
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve())
    client.once('error', reject)
  })
  const sockets = (bridge as unknown as { clients: Map<string, WebSocket> }).clients
  const accepted = sockets.get('ses_listener')
  expect(accepted).toBeDefined()
  expect(accepted!.listenerCount('error')).toBeGreaterThan(0)
  client.close()
})

test('an unmasked frame from an authenticated bridge does not take the relay down', async () => {
  const token = registerBridgeSession('ses_hostile')
  const socket = await rawUpgrade('ses_hostile', token)

  // RFC 6455 §5.1: every frame a CLIENT sends must be masked. This one is not,
  // so `ws` raises 'Invalid WebSocket frame: MASK must be set' on the receiver.
  // Three bytes: FIN+text opcode, length 1 (mask bit clear), one payload byte.
  socket.write(Buffer.from([0x81, 0x01, 0x41]))
  await new Promise((resolve) => setTimeout(resolve, 250))

  expect(await stillServing()).toBe(true)
  socket.destroy()
})

test('a reserved-bit violation is confined to its own socket', async () => {
  const victimToken = registerBridgeSession('ses_victim')
  const attackerToken = registerBridgeSession('ses_attacker')
  const victim = await rawUpgrade('ses_victim', victimToken)
  const attacker = await rawUpgrade('ses_attacker', attackerToken)

  // RSV1 set with no extension negotiated — another receiver-level violation.
  attacker.write(Buffer.from([0xc1, 0x80, 0x00, 0x00, 0x00, 0x00]))
  await new Promise((resolve) => setTimeout(resolve, 250))

  expect(await stillServing()).toBe(true)
  // The victim's session is untouched: it still has a connected bridge.
  expect(bridge.isConnected('ses_victim')).toBe(true)
  victim.destroy()
  attacker.destroy()
})

test('a burst of malformed frames from many sockets leaves the relay serving', async () => {
  const sockets: net.Socket[] = []
  for (let i = 0; i < 8; i++) {
    const token = registerBridgeSession(`ses_flood_${i}`)
    const socket = await rawUpgrade(`ses_flood_${i}`, token)
    socket.on('error', () => {}) // the peer resets these; that is the point
    socket.write(Buffer.from([0x81, 0x01, 0x41]))
    sockets.push(socket)
  }
  await new Promise((resolve) => setTimeout(resolve, 400))

  expect(await stillServing()).toBe(true)
  for (const s of sockets) s.destroy()
})
