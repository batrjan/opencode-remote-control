import { afterAll, beforeAll, expect, test } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type { Server } from 'node:http'
import { startServer } from '../src/server'
import { httpRequestTimeoutMs, proxyBodyLimitBytes, slowUplinkBytesPerSecond } from '../src/config'

/**
 * How long a request has to ARRIVE — the one bound on a held charge that the
 * relay was leaving to Node's default.
 *
 * The inbound budget gives a charge back when the response ends, and cuts a
 * body that stops arriving. Above both sits `server.requestTimeout`: the clock
 * that ends a request which never finishes arriving however well it behaves
 * otherwise. `http.createServer()` with no options inherits 300 s, and 300 s is
 * not a number this project chose — a 25 MiB paste over its own 0.74 Mbit/s
 * uplink takes 283 s, so the default sat within seconds of the largest
 * legitimate body the relay accepts, and the checking interval (30 s) put the
 * real cut somewhere in 300-330 s.
 *
 * So it is set from the same two numbers the body limit is reasoned about with,
 * and pinned here. The second test pins what the choice rests on: the clock
 * bounds the ARRIVAL of a request, never a response that is already being
 * written — an SSE stream or a prompt waiting on its bridge is not cut by it.
 */

let server: Server

beforeAll(async () => {
  server = await startServer(0)
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
})

test('the relay decides its own request timeout instead of inheriting one', () => {
  console.log(`requestTimeout=${server.requestTimeout} ms headersTimeout=${server.headersTimeout} ms`)
  expect(server.requestTimeout).toBe(httpRequestTimeoutMs())

  // Whatever it is set to, a maximal body must fit through it on the uplink
  // the project is built for — otherwise the relay 408s the very paste its
  // body limit exists to allow.
  const maximalBodyMs = (proxyBodyLimitBytes() / slowUplinkBytesPerSecond()) * 1000
  console.log(`a maximal body needs ${Math.round(maximalBodyMs / 1000)} s on the uplink this is sized for`)
  expect(server.requestTimeout).toBeGreaterThan(maximalBodyMs)
  // And Node's own header clock has to stay under it, or it is the one that
  // decides (Node checks both on the same sweep).
  expect(server.headersTimeout).toBeLessThanOrEqual(server.requestTimeout)
})

test("the request clock does not touch a response the relay is still holding", async () => {
  // The property the number above is chosen against: requestTimeout runs until
  // the REQUEST is complete. A prompt whose bridge takes minutes to answer, or
  // an event stream held open for hours, is outside it — so raising it costs
  // nothing but the life of a request that is still arriving.
  const probe = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => setTimeout(() => res.end('ok'), 900))
  })
  probe.requestTimeout = 300
  probe.headersTimeout = 200
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const port = (probe.address() as net.AddressInfo).port
  const answer = await new Promise<string>((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write('POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\nhi')
    })
    socket.on('data', (chunk: Buffer) => resolve(chunk.toString('latin1').split('\r\n')[0]))
    socket.on('error', () => resolve('error'))
  })
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  console.log(`response held 900 ms past a 300 ms requestTimeout: ${answer}`)
  expect(answer).toContain('200')
})
