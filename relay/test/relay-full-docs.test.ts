import { afterEach, expect, test, vi } from 'vitest'
import request from 'supertest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import {
  config,
  departedBridgeMs,
  httpRequestTimeoutMs,
  maxSessions,
  proxyBodyLimitBytes,
  proxyInboundMinRateBytes,
  proxyInboundReserveBytes,
  proxyInboundShareBytes,
  proxyInboundSmallBodyBytes,
  proxyMaxInboundBytes,
  proxyMaxInflightPosts,
  proxyStallCheckMs,
  proxyStallStrikes,
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

/**
 * The source of one function: its `function` line through the `}` that closes
 * it at the same indentation.
 *
 * Reading a fixed number of characters from the start instead is a trap for
 * whoever edits the function next: the slice that used to be read here left 88
 * characters of headroom, so any comment added near the top of
 * admitInboundBody pushed what this test looks for out of view and failed it
 * for a reason that had nothing to do with the documentation.
 */
function functionSource(src: string, name: string): string {
  const at = src.indexOf(`function ${name}`)
  expect(at, `${name} is gone from the source this test reads`).toBeGreaterThan(-1)
  const from = src.lastIndexOf('\n', at) + 1
  const indent = /^[ \t]*/.exec(src.slice(from))![0]
  const end = src.indexOf(`\n${indent}}`, at)
  expect(end, `${name} has no closing brace at its own indentation`).toBeGreaterThan(at)
  return src.slice(from, end)
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

/**
 * The inbound budgets are four numbers derived from two, and the row that
 * explains them quoted the arithmetic from before the derivation changed: the
 * ceiling's floor went from eight body limits to sixteen (so 400 MiB, not the
 * 128 MiB the env default names), the per-share slice gained its two-body
 * floor, and the reserve for shares holding nothing did not exist at all. An
 * operator sizing a relay from that row would have sized it for half the
 * memory the process will actually hold.
 */
const NUMERALS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
]

/** The `Env vars` row whose first cell names `variable`. */
function envRow(variable: string): string {
  const row = tableAfter(fs.readFileSync(README, 'utf8'), 'Env vars').find((r) =>
    r.split('|')[1]?.includes(`\`${variable}\``),
  )
  expect(row, `an env table row for ${variable}`).toBeDefined()
  return row!
}

test("README's inbound proxy row quotes the budgets config computes, not the env defaults", () => {
  const row = envRow('RELAY_PROXY_MAX_INBOUND_BYTES')
  const src = fs.readFileSync(CONFIG_SRC, 'utf8')

  // Every number the code computes, in the unit the row writes it in.
  for (const [what, bytes] of [
    ['one body', proxyBodyLimitBytes()],
    ['the process ceiling', proxyMaxInboundBytes()],
    ["one share's slice", proxyInboundShareBytes()],
    ['the reserve for quiet shares', proxyInboundReserveBytes()],
  ] as const) {
    expect(row, `${what} is ${bytes / MiB} MiB and the row does not say so`).toContain(`${bytes / MiB} MiB`)
  }
  expect(row, 'the row does not say what counts as a small body').toContain(
    `${proxyInboundSmallBodyBytes() / 1024} KiB`,
  )
  expect(row, 'the row does not quote the in-flight POST cap').toContain(`(${proxyMaxInflightPosts()})`)

  // And the relations between them, which is what an operator tunes with. The
  // floor is a multiple in the source, so the row has to name the same one.
  const floor = src.match(/RELAY_PROXY_MAX_INBOUND_BYTES',\s*(\d+) \* 1024 \* 1024\),\s*(\d+) \* proxyBodyLimitBytes/)
  expect(floor, 'proxyMaxInboundBytes no longer reads as env-default vs a multiple of the body limit').not.toBeNull()
  expect(row, `the env default is ${floor![1]} MiB`).toContain(`${floor![1]} MiB`)
  expect(row, `the ceiling is never below ${NUMERALS[Number(floor![2])]} body limits`).toContain(
    `${NUMERALS[Number(floor![2])]} body limits`,
  )
  expect(row, 'the row does not say how many quiet shares the reserve holds').toContain(
    String(proxyInboundReserveBytes() / proxyInboundSmallBodyBytes()),
  )
  expect(row, 'the row does not say a share gets an eighth of the ceiling').toMatch(/an eighth of (?:that|the) ceiling/)
  expect(proxyMaxInboundBytes() / proxyInboundShareBytes()).toBe(8)
})

test("README's stall row covers the request half the same window now cuts", () => {
  const row = envRow('RELAY_PROXY_STALL_CHECK_MS')
  expect(row, 'the check interval').toContain(`${proxyStallCheckMs() / 1000} s`)
  expect(row, 'the number of strikes').toContain(NUMERALS[proxyStallStrikes()])
  const tolerance = (proxyStallCheckMs() * proxyStallStrikes()) / 1000
  expect(row, 'the whole tolerance, in digits or in words').toMatch(
    new RegExp(`(?:${tolerance}|${NUMERALS[tolerance] ?? tolerance}) seconds`),
  )

  // admitInboundBody runs the same no-progress rule on a body that stops
  // arriving, and answers it — a status a client author has to know about.
  const adapter = fs.readFileSync(fileURLToPath(new URL('../src/proxy/adapter.ts', import.meta.url)), 'utf8')
  const watchdog = functionSource(adapter, 'admitInboundBody')
  expect(watchdog, 'the inbound stall watchdog no longer answers 408').toMatch(/status\(408\)/)
  expect(row, 'the row never mentions the request body the same window cuts').toMatch(/408/)

  // The two halves stopped being the same rule when the request half became a
  // RATE, and the row kept describing the one that was replaced: a body moving
  // "no byte at all" is cut, one "still arriving, however slowly" is safe, and
  // over both sits "Node's own five-minute requestTimeout" the relay has since
  // set itself. A steady 4000 B/s upload is answered 408 in 10.008 s, so the
  // row has to name the floor it is under, where that floor comes from, and
  // whose clock bounds a body that keeps paying it.
  expect(row, 'the row never names the rate floor an arriving body must pay').toContain(
    `${(proxyInboundMinRateBytes() / 1024).toFixed(1)} KiB/s`,
  )
  expect(row, 'the row never says the floor follows the body limit').toContain('RELAY_PROXY_BODY_LIMIT_BYTES')
  const minutes = httpRequestTimeoutMs() / 60_000
  expect(row, "the row never names the request clock the relay chooses, in digits or in words").toMatch(
    new RegExp(`(?:${minutes}|${NUMERALS[minutes] ?? minutes})[- ]minutes?`),
  )
  expect(row, 'the row still describes the pulse rule the rate replaced').not.toMatch(/five-minute|however slowly/)
})
