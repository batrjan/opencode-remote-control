import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OpencodeClient } from '../src/opencode'
import { afterAll, beforeAll, expect, test } from 'vitest'

/**
 * Mock OpenCode HTTP API. The brief's snippet targeted the live server on
 * localhost:51863, but a test cannot bind an occupied port nor depend on a
 * machine-specific password, so the client is pointed at an ephemeral mock
 * that enforces the same basic-auth credentials ('opencode'/'password').
 */
let server: Server
let url: string

beforeAll(async () => {
  const expected =
    'Basic ' + Buffer.from('opencode:password').toString('base64')
  server = createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      res.writeHead(401)
      res.end()
      return
    }
    if (req.url === '/session') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([{ id: 'sess1', directory: '/path' }]))
      return
    }
    // opencode 1.18.30 names the next (older) page of a transcript only here.
    if (req.url === '/session/sess1/message?limit=2') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Next-Cursor': 'CUR' })
      res.end(JSON.stringify([{ info: { id: 'm2' }, parts: [] }]))
      return
    }
    if (req.url === '/session/sess1/message?limit=200') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([{ info: { id: 'm1' }, parts: [] }]))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

test('get sessions', async () => {
  const client = new OpencodeClient(url, 'opencode', 'password')
  const sessions = await client.getSessions()
  expect(sessions.length).toBeGreaterThan(0)
})

/**
 * The web UI learns that older messages exist only from X-Next-Cursor, so the
 * pass-through must hand it on; without it a viewer never saw past the last
 * 20 messages of a shared session (see relay/test/next-cursor.test.ts).
 */
test('request passes on the pagination cursor of a message page', async () => {
  const client = new OpencodeClient(url, 'opencode', 'password')
  const paged = await client.request('GET', '/session/sess1/message?limit=2')
  expect(paged.status).toBe(200)
  expect(paged.nextCursor).toBe('CUR')
  const last = await client.request('GET', '/session/sess1/message?limit=200')
  expect(last.status).toBe(200)
  expect(last.nextCursor).toBeUndefined()
})
