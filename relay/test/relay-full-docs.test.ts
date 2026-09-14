import { afterEach, expect, test, vi } from 'vitest'
import request from 'supertest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import {
  config,
  departedBridgeMs,
  maxSessions,
  sseMaxBufferBytes,
  sseMaxExemptBytes,
  sseMaxParkedBytes,
} from '../src/config'

/**
 * Whether what an owner and an operator read about the relay's session cap and
 * its SSE limits is what actually runs.
 *
 * The session cap (RELAY_MAX_SESSIONS) and the bound on the one large SSE frame
 * a stuck viewer is let off (RELAY_SSE_MAX_EXEMPT_BYTES) shipped without a line
 * in README.md or DEPLOY.md. README still promised that a share left alone
 * lives until 24 h without bridge traffic, while a full relay ends the share
 * whose bridge has been gone longest once it has been gone 5 minutes. So an
 * owner back from lunch on a busy relay found "Remote control stopped" (its
 * bridge re-dialled into a 401) against what the docs said, and the operator
 * found neither the limit nor the variable that raises it.
 *
 * The docs quote the defaults, so the variables they are read from are cleared.
 */

const README = fileURLToPath(new URL('../../README.md', import.meta.url))
const DEPLOY = fileURLToPath(new URL('../../DEPLOY.md', import.meta.url))
const CONFIG_SRC = fileURLToPath(new URL('../src/config.ts', import.meta.url))
const MiB = 1024 * 1024
const MINUTE = 60_000

const TUNABLES = ['RELAY_MAX_SESSIONS', 'RELAY_WS_PING_INTERVAL_MS', 'RELAY_WS_PONG_GRACE_ROUNDS']
for (const name of [...TUNABLES, 'RELAY_SSE_MAX_BUFFER_BYTES', 'RELAY_SSE_MAX_EXEMPT_BYTES', 'RELAY_SSE_MAX_PARKED_BYTES']) {
  delete process.env[name]
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const name of TUNABLES) delete process.env[name]
})

/** 2000 -> "2,000", the way the docs write counts. */
const count = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** The rows of the table that follows the line starting with `lead`. */
function tableAfter(markdown: string, lead: string): string[] {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => l.startsWith(lead))
  expect(start, `a table after "${lead}"`).toBeGreaterThan(-1)
  const rows: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('|')) rows.push(line)
    else if (rows.length) break
  }
  return rows
}

/** A markdown section (its heading through the next `## `), whitespace collapsed. */
function section(markdown: string, heading: RegExp): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => /^## /.test(l) && heading.test(l))
  expect(start, `a "## " section matching ${heading}`).toBeGreaterThan(-1)
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

test("README's env table names every variable the relay's config reads", () => {
  const src = fs.readFileSync(CONFIG_SRC, 'utf8')
  const read = new Set([
    ...[...src.matchAll(/envInt\(\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]),
  ])
  // Read by nothing: relayApiKey() has no caller, so an old .env that still sets
  // it starts fine and the key does nothing. A knob that does nothing is not one
  // to offer in the table.
  read.delete('RELAY_API_KEY')
  expect(read.size).toBeGreaterThan(10)

  const documented = new Set(
    tableAfter(fs.readFileSync(README, 'utf8'), 'Env vars').flatMap((row) =>
      [...row.matchAll(/`([A-Z][A-Z0-9_]*)(?:=[^`]*)?`/g)].map((m) => m[1]),
    ),
  )
  expect([...read].filter((name) => !documented.has(name)).sort()).toEqual([])
})

test("README's SSE keep-alive row quotes the byte limits config sets, each with its variable", () => {
  const row = tableAfter(fs.readFileSync(README, 'utf8'), '| Hop |').find((r) => r.startsWith('| relay → viewer (SSE) |'))
  expect(row, 'the relay → viewer (SSE) row').toBeDefined()
  const cells = row!.split(' | ')
  const quoted = new Set([...cells[1].matchAll(/(\d+) MiB/g)].map((m) => Number(m[1])))
  const limits = new Set([sseMaxBufferBytes(), sseMaxExemptBytes(), sseMaxParkedBytes()].map((b) => b / MiB))
  expect([...quoted].sort((a, b) => a - b)).toEqual([...limits].sort((a, b) => a - b))
  for (const name of ['RELAY_SSE_MAX_BUFFER_BYTES', 'RELAY_SSE_MAX_EXEMPT_BYTES', 'RELAY_SSE_MAX_PARKED_BYTES']) {
    expect(cells.at(-1)).toContain(`\`${name}\``)
  }
})

test("README's paragraph on ending a share tells what a full relay does to a share whose bridge left", () => {
  const paragraph = fs
    .readFileSync(README, 'utf8')
    .split(/\n\s*\n/)
    .find((p) => p.startsWith('Ending a share:'))
  expect(paragraph, 'the "Ending a share:" paragraph').toBeDefined()
  const text = paragraph!.replace(/\s+/g, ' ')
  // The day the reaper allows still holds, for a relay that is not full.
  expect(text).toContain(`${config.orphanReapMs / 3_600_000} h`)
  const at = text.search(/\bfull\b/)
  expect(at, 'a mention of a full relay').toBeGreaterThan(-1)
  const full = text.slice(at)
  expect(full).toContain('`RELAY_MAX_SESSIONS`')
  expect(full).toContain(count(maxSessions()))
  expect(full).toContain(`${departedBridgeMs() / MINUTE} minutes`)
})

test('DEPLOY.md documents the session cap, and what it says to grep for finds both lines a full relay logs', async () => {
  const text = section(fs.readFileSync(DEPLOY, 'utf8'), /RELAY_MAX_SESSIONS/)
  const prose = text.replace(/\s+/g, ' ')
  expect(prose).toContain(count(maxSessions()))
  expect(prose).toContain(`${departedBridgeMs() / MINUTE} minutes`)
  const grep = text.match(/docker compose logs[^\n|]*\|\s*grep\s+'?([^'\s]+)'?/)
  expect(grep, 'a `docker compose logs … | grep …` line').not.toBeNull()
  const pattern = grep![1]

  // The two lines: a share ended to make room, then a registration refused.
  vi.useFakeTimers({ toFake: ['Date'] })
  process.env.RELAY_MAX_SESSIONS = '1'
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = new Store()
  const app = createApp(store)
  const post = (session_id: string, ip: string) =>
    request(app).post('/api/sessions').set('X-Forwarded-For', ip).send({ session_id, directory: '/work', title: 't' })
  expect((await post('ses_lunch', '198.51.100.1')).status).toBe(201)
  // Its bridge connected, then the laptop was closed.
  store.touchSession('ses_lunch')
  vi.setSystemTime(Date.now() + departedBridgeMs() + MINUTE)
  expect((await post('ses_next', '203.0.113.1')).status).toBe(201)
  expect(store.getSession('ses_lunch')).toBeUndefined()
  // ses_next waits for its bridge, which has minutes to dial: nothing to take.
  expect((await post('ses_refused', '203.0.113.2')).status).toBe(503)

  const lines = warn.mock.calls.map((call) => call.join(' '))
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatch(/ended share/)
  expect(lines[1]).toMatch(/registration refused/)
  for (const line of lines) expect(line).toContain(pattern)
})
