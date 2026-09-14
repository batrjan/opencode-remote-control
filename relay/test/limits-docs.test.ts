import { expect, test } from 'vitest'
import request from 'supertest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { config } from '../src/config'

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

/**
 * Whether what the operator reads about rate limits is what actually runs.
 *
 * The per-address limit on activation attempts was removed, and the session
 * lock went from 20 failures to 5, but the prose around them was not updated.
 * The nginx zones file told whoever installs it that the relay's real brake
 * was "5 activations per IP per minute, 50 per hour" plus a lock "after 20
 * failures"; DEPLOY.md said the activation brake keyed on X-Forwarded-For, and
 * quoted the edge limits from before they were raised (oc_activate 20 r/m
 * against the 120 r/m nginx is configured with, oc_general 50 r/s burst 200
 * against 200 r/s burst 400). Nothing was exposed — the lock that does run is
 * stricter than the one described — but someone sizing the edge, reading a
 * lockout report or reviewing `trust proxy` reasoned from a defence that does
 * not exist and from numbers six and four times off.
 *
 * nginx is not run here: the rates are read from the repo's zones file and
 * vhost, the relay's limits from config, and the last two tests pin the
 * behaviour the corrected text describes.
 */

const LIMITS = fileURLToPath(new URL('../../nginx/conf.d/opencode-remote-control-limits.conf', import.meta.url))
const VHOST = fileURLToPath(new URL('../../nginx/opencode.b4tr.net.conf', import.meta.url))
const DEPLOY = fileURLToPath(new URL('../../DEPLOY.md', import.meta.url))
const CONFIG_SRC = fileURLToPath(new URL('../src/config.ts', import.meta.url))
const STORE_SRC = fileURLToPath(new URL('../src/store.ts', import.meta.url))

type Limit = { rate: string; burst: string | undefined }

/** zone -> rate from the zones file, burst from the vhost's limit_req. */
function nginxLimits(): Map<string, Limit> {
  const limits = new Map<string, Limit>()
  for (const m of fs.readFileSync(LIMITS, 'utf8').matchAll(/^\s*limit_req_zone\s+\S+\s+zone=(\w+):\S+\s+rate=(\d+r\/[sm])\s*;/gm)) {
    limits.set(m[1], { rate: m[2], burst: undefined })
  }
  for (const m of fs.readFileSync(VHOST, 'utf8').matchAll(/^\s*limit_req\s+zone=(\w+)(?:\s+burst=(\d+))?/gm)) {
    const limit = limits.get(m[1])
    if (!limit) throw new Error(`${VHOST} uses limit_req zone ${m[1]}, which ${LIMITS} does not define`)
    limit.burst = m[2]
  }
  return limits
}

/** A file's comment text as one line, so a phrase wrapped across `#` lines still matches. */
function commentText(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trimStart().startsWith('#'))
    .map((l) => l.trimStart().replace(/^#+/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
}

test("DEPLOY.md quotes nginx's edge limits as the repo's nginx config sets them", () => {
  const expected = nginxLimits()
  expect([...expected.keys()].sort()).toEqual(['oc_activate', 'oc_general', 'oc_register'])

  const row = fs
    .readFileSync(DEPLOY, 'utf8')
    .split('\n')
    .find((l) => l.includes('`limit_req zone=oc_activate`'))
  expect(row, 'the vhost table row for limit_req').toBeDefined()
  const quoted = new Map<string, Limit>()
  for (const m of row!.matchAll(/(oc_\w+)` \((\d+) r\/([sm])(?:, burst (\d+))?\)/g)) {
    quoted.set(m[1], { rate: `${m[2]}r/${m[3]}`, burst: m[4] })
  }
  expect(Object.fromEntries(quoted)).toEqual(Object.fromEntries(expected))
})

test("the nginx zones file describes the relay's activation brake as it is configured", () => {
  const text = commentText(LIMITS)
  // The removed per-address rate on activations, in the words it was written in.
  expect(text).not.toMatch(/per (?:IP|address) per minute|\b(?:\d+|five|fifty) (?:activations )?(?:a|an|per) (?:minute|hour)\b/i)
  // Every failure count it quotes is the one that locks a share.
  const counts = [...text.matchAll(/\b(\d+) (?:consecutive )?(?:wrong codes|failures|failed attempts)\b/gi)].map((m) => Number(m[1]))
  expect(counts.length).toBeGreaterThan(0)
  expect(counts).toEqual(counts.map(() => config.sessionFailLockThreshold))
  for (const m of text.matchAll(/\b(\d+) minutes\b/g)) expect(Number(m[1])).toBe(config.sessionFailLockMs / 60_000)
  const repeats = [...text.matchAll(/\b(\d+) repeats\b/g)].map((m) => Number(m[1]))
  expect(repeats).toEqual([config.codeFailBlockThreshold])
})

test("config's list of tracking maps names exactly the Store's bounded maps", () => {
  const listed = fs.readFileSync(CONFIG_SRC, 'utf8').match(/in-memory tracking maps \(([^)]*)\)/)
  expect(listed, 'the maxTrackingEntries comment in config.ts').not.toBeNull()
  const named = listed![1].replace(/\*/g, ' ').split(/[\s,]+/).filter((w) => /^[a-z]\w*$/i.test(w) && w !== 'and')
  const store = fs.readFileSync(STORE_SRC, 'utf8')
  const bounded = new Set([...store.matchAll(/this\.(?:setBounded|addBounded)\(this\.(\w+),/g)].map((m) => m[1]))
  expect(named.sort()).toEqual([...bounded].sort())
})

const activate = (app: ReturnType<typeof createApp>, id: string, code: string, ip: string) =>
  request(app).post('/api/activate').set('X-Forwarded-For', ip).send({ code, session_id: id })

test('wrong codes from one address are not limited per address', async () => {
  const store = new Store()
  const app = createApp(store)
  const ADDRESS = '198.51.100.77'
  const codes: string[] = []
  // Fifteen shares, one short of the lock on each: sixty wrong codes from a
  // single address, far past the old five a minute. Only per-share counts move.
  for (let s = 0; s < 15; s++) {
    codes.push(store.createSession(`ses_addr_${s}`, '/work', 't', '203.0.113.1').access_code)
    for (let k = 0; k < config.sessionFailLockThreshold - 1; k++) {
      expect((await activate(app, `ses_addr_${s}`, `NO${k}`, ADDRESS)).status).toBe(400)
    }
  }
  expect((await activate(app, 'ses_addr_0', codes[0], ADDRESS)).status).toBe(200)
})

test('the failure count the docs quote is the one that locks a share, from any address', async () => {
  const store = new Store()
  const app = createApp(store)
  const { access_code } = store.createSession('ses_docs_lock', '/work', 't', '203.0.113.1')
  for (let i = 0; i < config.sessionFailLockThreshold; i++) {
    expect((await activate(app, 'ses_docs_lock', `NO${i}`, `192.0.2.${i + 1}`)).status).toBe(400)
  }
  const locked = await activate(app, 'ses_docs_lock', access_code, '192.0.2.200')
  expect(locked.status).toBe(429)
  expect(locked.body).toEqual({ error: 'rate limited' })
})
