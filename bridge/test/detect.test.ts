import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { detectOpenCodePort, listCandidatePorts } from '../src/detect'
import { afterAll, beforeAll, expect, test } from 'vitest'

/**
 * The detection pipeline is two steps: list listening ports (lsof, machine
 * state) and health-probe them. The probe is tested against a real in-process
 * server with an injected candidate list, so a real opencode running on the
 * developer's machine cannot decide the result — that made the suite fail
 * whenever the bridge itself had spawned `opencode serve`.
 */
let server: Server
let mockPort: number

beforeAll(async () => {
  process.env.OPENCODE_SERVER_USERNAME = 'opencode'
  process.env.OPENCODE_SERVER_PASSWORD = 'test-password'
  const expected = 'Basic ' + Buffer.from('opencode:test-password').toString('base64')
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

test('detectOpenCodePort returns the first healthy candidate', async () => {
  const port = await detectOpenCodePort([1, mockPort])
  expect(port).toBeTypeOf('number')
  expect(port).toBe(mockPort)
})

test('detectOpenCodePort skips listeners that fail the credentialed probe', async () => {
  const unauthorized = createServer((_req, res) => {
    res.writeHead(401)
    res.end()
  })
  await new Promise<void>((resolve) => unauthorized.listen(0, '127.0.0.1', resolve))
  const badPort = (unauthorized.address() as AddressInfo).port
  try {
    expect(await detectOpenCodePort([badPort, mockPort])).toBe(mockPort)
    await expect(detectOpenCodePort([badPort])).rejects.toThrow('opencode not found')
  } finally {
    await new Promise((resolve) => unauthorized.close(resolve))
  }
})

test('detectOpenCodePort rejects when nothing is healthy', async () => {
  await expect(detectOpenCodePort([])).rejects.toThrow('opencode not found')
})

test('listCandidatePorts sees the in-process listener and returns unique ports', async () => {
  const ports = await listCandidatePorts()
  expect(ports).toContain(mockPort)
  expect(new Set(ports).size).toBe(ports.length)
  expect(ports.every((p) => Number.isInteger(p) && p > 0)).toBe(true)
})
