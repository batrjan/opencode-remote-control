import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OpencodeClient } from '../src/opencode'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'

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

/**
 * The question routes are not long-polls, so they get the normal 30 s guard.
 *
 * Every path under /question used to be armed for 130 s, as if opencode held
 * it open until an event arrived. It does not: the pending list (which the
 * relay reads at every viewer bootstrap, and the question guard before every
 * reply) is answered at once, and a reply or reject only settles a question
 * that is already waiting. A local opencode that stopped answering therefore
 * kept each such request open for over two minutes, long after the relay had
 * given the viewer its timeout.
 */
test('request gives the question list, reply and reject the normal timeout', async () => {
  const client = new OpencodeClient(url, 'opencode', 'password')
  const spy = vi.spyOn(globalThis, 'setTimeout')
  try {
    const armed: Record<string, unknown[]> = {}
    for (const [method, path] of [
      ['GET', '/question?directory=%2Fpath'],
      ['POST', '/question/que_1/reply?directory=%2Fpath'],
      ['POST', '/question/que_1/reject?directory=%2Fpath'],
    ] as const) {
      spy.mockClear()
      await client.request(method, path, method === 'POST' ? {} : undefined)
      armed[`${method} ${path}`] = spy.mock.calls.map((call) => call[1]).filter((ms) => typeof ms === 'number' && ms >= 30_000)
    }
    expect(armed).toEqual({
      'GET /question?directory=%2Fpath': [30_000],
      'POST /question/que_1/reply?directory=%2Fpath': [30_000],
      'POST /question/que_1/reject?directory=%2Fpath': [30_000],
    })
  } finally {
    spy.mockRestore()
  }
})
