import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { ensureOpenCodeServer } from '../src/detect'

/**
 * Two ways the terminal protection could be worse than it looks.
 *
 * The sanitizer is defined by the very bytes it removes, so writing them raw
 * into the source makes git call the file binary: its diffs stop being
 * reviewable and `grep` stops finding it — the same class of bug that already
 * hid RELAY_PROXY_STALL_* in the relay once. Escapes mean the same regex and a
 * readable file.
 *
 * And the password the bridge generates for the server it spawns is the thing
 * standing between the owner's machine and any web page they open; the tail of
 * that server's log is put in front of the owner and written to bridge.log, so
 * it must not carry the password there.
 */

const FAKE_OPENCODE = `#!/usr/bin/env node
// Never reports a port, and echoes its environment the way a server logging its
// own config would.
console.error('INFO  server password=' + (process.env.OPENCODE_SERVER_PASSWORD ?? ''))
setTimeout(() => {}, 60_000)
`

let binDir: string
const previousPath = process.env.PATH

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), 'rc-fake-opencode-log-'))
  const entry = path.join(binDir, 'opencode')
  writeFileSync(entry, FAKE_OPENCODE)
  chmodSync(entry, 0o755)
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`
  delete process.env.OPENCODE_SERVER_PASSWORD
})

afterAll(() => {
  process.env.PATH = previousPath
})

test('the terminal sanitizer is written in escapes, so its own source stays text', () => {
  const source = readFileSync(new URL('../src/errors.ts', import.meta.url))
  // What git's own heuristic looks at: a NUL, or a control byte that is not
  // tab/newline/carriage return, in the first chunk of the file.
  const offending = [...source].map((byte, at) => ({ byte, at })).filter(({ byte }) => byte === 0 || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f)
  expect(offending.map(({ byte, at }) => `0x${byte.toString(16)} at ${at}`), 'raw control bytes in bridge/src/errors.ts').toEqual([])
})

test('a spawned server that fails to start does not put its password in the error', async () => {
  // Nothing is listening, so nothing is judged: this is the spawn path.
  const failure = await ensureOpenCodeServer({ serves: {}, listListeners: async () => [] }).then(
    (ensured) => {
      ensured.spawned?.kill()
      return undefined
    },
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  )
  expect(failure, 'the stand-in never reports a port, so the start fails').toBeDefined()
  expect(failure).toContain('did not report a port')
  // The tail is quoted to explain the failure; the password in it is not an
  // explanation, it is a credential on the owner's screen and in bridge.log.
  // The stand-in logs its own, so what must be left is the marker and no
  // secret-shaped run of base64url characters.
  expect(failure, 'the tail still explains the failure').toContain('server password=')
  expect(failure).toContain('<redacted>')
  expect(/[A-Za-z0-9_-]{20,}/.exec(failure ?? ''), `secret-shaped text left in: ${failure}`).toBe(null)
}, 30_000)
