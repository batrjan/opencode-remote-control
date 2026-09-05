import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { detectOpenCodePort } from '../src/detect'
import { afterAll, beforeAll, expect, test } from 'vitest'

/**
 * The detection pipeline (lsof + health probe) runs against real listeners,
 * so the test starts a real in-process HTTP server on an ephemeral port
 * (visible to lsof as a `node` LISTEN entry) that answers /global/health
 * only for the credentials the detector will send.
 */
let server: Server
let mockPort: number

beforeAll(async () => {
  process.env.OPENCODE_SERVER_USERNAME = 'opencode'
  process.env.OPENCODE_SERVER_PASSWORD = 'test-password'
  const expected =
    'Basic ' + Buffer.from('opencode:test-password').toString('base64')
  server = createServer((req, res) => {
    if (req.url === '/global/health' && req.headers.authorization === expected) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ healthy: true }))
    } else {
      res.writeHead(401)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  mockPort = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

test('detectOpenCodePort returns number', async () => {
  const port = await detectOpenCodePort()
  // brief used jest-extended's toBeNumber(); vitest core equivalent:
  expect(port).toBeTypeOf('number')
})

test('detectOpenCodePort finds the healthy listener', async () => {
  const port = await detectOpenCodePort()
  expect(port).toBe(mockPort)
})
