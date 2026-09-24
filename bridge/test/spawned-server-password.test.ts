import type { ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { basicAuthHeader } from '../src/config'
import { ensureOpenCodeServer } from '../src/detect'

/**
 * A server the bridge spawns must not be reachable without credentials.
 *
 * `opencode serve` authenticates nothing when OPENCODE_SERVER_PASSWORD is
 * empty, and it answers cross-origin requests from any loopback page — so an
 * unsecured server the bridge started is shell access to the owner's machine
 * for any web page they happen to open, with no access code and no relay
 * anywhere in the path. Checked here against a stand-in that mirrors opencode
 * 1.18.31's rule (verified against the real binary): a password in the
 * environment means HTTP Basic on every route, an empty one means none at all.
 */
const FAKE_OPENCODE = `#!/usr/bin/env node
const { createServer } = require('node:http')
const password = process.env.OPENCODE_SERVER_PASSWORD ?? ''
const expected =
  'Basic ' +
  Buffer.from((process.env.OPENCODE_SERVER_USERNAME ?? 'opencode') + ':' + password).toString('base64')
const server = createServer((req, res) => {
  if (password !== '' && req.headers.authorization !== expected) {
    res.writeHead(401)
    res.end()
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ healthy: true }))
})
server.listen(0, '127.0.0.1', () => {
  console.log('opencode server listening on http://127.0.0.1:' + server.address().port)
})
`

let binDir: string
const spawned: ChildProcess[] = []

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), 'rc-fake-opencode-'))
  const entry = path.join(binDir, 'opencode')
  writeFileSync(entry, FAKE_OPENCODE)
  chmodSync(entry, 0o755)
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`
  // The owner who never set one — the case the finding is about.
  delete process.env.OPENCODE_SERVER_PASSWORD
})

afterAll(() => {
  for (const child of spawned) child.kill()
})

test('a spawned opencode server refuses a request that carries no password', async () => {
  const ensured = await ensureOpenCodeServer({ serves: {}, listListeners: async () => [] })
  expect(ensured.spawned).toBeDefined()
  spawned.push(ensured.spawned!)
  const health = `http://127.0.0.1:${ensured.port}/global/health`
  expect((await fetch(health)).status).toBe(401)

  const password = (ensured as { password?: string }).password
  // Strong enough that guessing it is not a way in, and never the owner's.
  expect(password ?? '').toMatch(/^[A-Za-z0-9_-]{22,}$/)
  // …and the bridge itself can still talk to the server it started.
  const authorized = await fetch(health, { headers: { Authorization: basicAuthHeader('opencode', password!) } })
  expect(authorized.status).toBe(200)
  expect(await authorized.json()).toEqual({ healthy: true })
})

test('attaching to a server that asks for nothing warns the owner', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  // A server the owner started themselves, with no password: this bridge
  // cannot fix it, so it is used and reported rather than refused.
  const openPort = await startUnsecuredServer()
  // `serves: {}` asks the candidate for nothing beyond health: which server
  // holds the session is decided in stranger-server-not-adopted.test.ts, and
  // what is under test here is the password policy of the one attached to.
  const attached = await ensureOpenCodeServer({ serves: {}, listListeners: async () => [{ port: openPort, pid: 1 }] })
  expect(attached.port).toBe(openPort)
  expect(attached.spawned).toBeUndefined()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('without a password'))
})

test('a server whose password the bridge does not hold is not attached to', async () => {
  // Another share's server, or the owner's own behind credentials this process
  // was not given: unusable, so this share starts one of its own.
  const guarded = await ensureOpenCodeServer({ serves: {}, listListeners: async () => [] })
  spawned.push(guarded.spawned!)
  const ours = await ensureOpenCodeServer({
    serves: {},
    listListeners: async () => [{ port: guarded.port, pid: guarded.spawned!.pid! }],
  })
  spawned.push(ours.spawned!)
  expect(ours.spawned).toBeDefined()
  expect(ours.port).not.toBe(guarded.port)
})

/** An `opencode serve` the owner started themselves, with no password set. */
async function startUnsecuredServer(): Promise<number> {
  const { spawn } = await import('node:child_process')
  const child = spawn('opencode', ['serve'], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  spawned.push(child)
  return await new Promise<number>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      const m = /http:\/\/[^:\s]+:(\d+)/.exec(chunk.toString())
      if (m) resolve(Number(m[1]))
    })
    child.on('error', reject)
  })
}
