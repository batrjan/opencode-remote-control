import { expect, test } from 'vitest'
import request from 'supertest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { viewerTokenFrom } from './helpers/viewer-token'

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

/**
 * Claims in the README's security section that the code does not back.
 *
 * "What sharing grants" reads as a list of things a viewer can *do*, and a
 * reader concludes that trusting someone with the code is trusting them with
 * the session. It is also trusting them with the owner's provider
 * credentials: /config, /global/config, /config/providers and /provider are on
 * the proxy's allowlist and are forwarded verbatim, so a viewer who never
 * types anything receives whatever API keys and MCP Authorization headers the
 * owner's config carries. "Controls the session" does not imply "reads your
 * API keys", so the table has to say it.
 *
 * The hostile-relay bullet promised that the bridge's allowlist keeps such a
 * relay to "no more of the OpenCode API than a viewer already can". The
 * allowlist accepted any `ses_…` in the path, so it did not — and the fix that
 * binds it is what the bullet must describe instead.
 *
 * And the machine running OpenCode answers on 127.0.0.1 during a share, with
 * no password by default. That is a trust boundary the README never mentioned.
 *
 * The three tests added below are the same shape for three claims that the
 * security fixes then made false: the proxy stopped REWRITING a foreign `:id`
 * onto the viewer's own session and started refusing it; `POST /api/leave`
 * gained an Origin check (and no page ever gained a button for it); and
 * `/health` gained a field. Each follows the code — the marker in the adapter,
 * the pages the relay actually serves, the object health.ts answers with — so
 * the day any of them changes again, the README has to change with it.
 */

const README = fileURLToPath(new URL('../../README.md', import.meta.url))
const ADAPTER = fileURLToPath(new URL('../src/proxy/adapter.ts', import.meta.url))
const HEALTH = fileURLToPath(new URL('../src/api/health.ts', import.meta.url))
const FAULTS = fileURLToPath(new URL('../src/faults.ts', import.meta.url))

/** A markdown table, from its header row to the blank line that ends it. */
function table(header: string): string {
  const lines = fs.readFileSync(README, 'utf8').split('\n')
  const start = lines.findIndex((l) => l.startsWith(header))
  expect(start, `no table starting ${header}`).toBeGreaterThan(-1)
  const rows: string[] = []
  for (const line of lines.slice(start)) {
    if (line.trim() === '') break
    rows.push(line)
  }
  return rows.join('\n')
}

// The four routes that carry the owner's config, and with it whatever
// credentials it holds. Read from the allowlist so this test follows the code:
// a route dropped from the proxy is a row the README may drop too.
const CONFIG_ROUTES = ['/config', '/config/providers', '/provider', '/global/config']

test("the viewer table admits what the config routes hand over", () => {
  const adapter = fs.readFileSync(ADAPTER, 'utf8')
  const allowed = CONFIG_ROUTES.filter((route) => adapter.includes(`['GET', '${route}']`))
  expect(allowed, 'the config routes left the proxy allowlist — update this test').toEqual(CONFIG_ROUTES)

  const viewerTable = table('| A viewer can |')
  for (const route of allowed) {
    expect(viewerTable, `${route} is proxied to a viewer but the table does not say so`).toContain(route)
  }
  expect(viewerTable, 'the table never names the credentials those routes carry').toMatch(/API key/i)
})

test('the hostile-relay bullet describes the binding the bridge enforces', () => {
  const readme = fs.readFileSync(README, 'utf8')
  // The claim the allowlist did not keep: it accepted any `ses_…`, so a
  // hostile relay reached every local session, not only the shared one.
  expect(readme).not.toMatch(/no more of the OpenCode API than a viewer already can/)
  const bullet = readme.slice(readme.indexOf('- **A compromised relay host.**'))
  expect(bullet.slice(0, 1200), 'the bullet does not say what the bridge binds').toMatch(
    /bound|shared session/i,
  )
})

test('the README names the local OpenCode server as a trust boundary', () => {
  const readme = fs.readFileSync(README, 'utf8')
  expect(readme, 'nothing about the password on the local server').toContain('OPENCODE_SERVER_PASSWORD')
})

test('the binding rows describe the refusal, not the rewrite the proxy dropped', () => {
  const readme = fs.readFileSync(README, 'utf8')
  const adapter = fs.readFileSync(ADAPTER, 'utf8')
  // Follow the code: the refusal, its marker, and the separate answer for a
  // walk that could not be finished all exist in the adapter.
  expect(adapter).toContain("VIEWER_AUTH_INVALID = 'viewer-invalid'")
  expect(adapter).toContain('function refuseForeignId')
  expect(adapter, 'an unprovable id is answered 502, not 401').toMatch(
    /function refuseForeignId[^]*?unproven[^]*?status\(502\)/,
  )

  // The old promise, in the two spellings the README carried it in. A rewrite
  // is not a weaker version of the refusal — it is the opposite behaviour, and
  // a client author who believes it sends the wrong id on purpose.
  expect(readme).not.toMatch(/rewrites the `:id` in every one of them/)
  expect(readme).not.toMatch(/`:id` is always rewritten/)

  // Both tables name the refusal where they describe the binding.
  const protects = table('| What protects the share |')
  const binding = protects.split('\n').find((l) => l.startsWith('| Forced session binding |'))!
  expect(binding, 'the security table does not name the 401').toMatch(/401/)
  expect(binding, 'the security table does not name the marker the UI keys on').toContain('X-OC-Relay-Auth')
  const proxied = table('| Endpoint ')
    .split('\n')
    .find((l) => l.includes('allowlisted OpenCode paths'))!
  expect(proxied, 'the HTTP surface row does not name the 401').toMatch(/401/)
  expect(proxied, 'the HTTP surface row does not name the 502 an unfinished walk gets').toMatch(/502/)
})

test('the /api/leave row states the 403 a cross-origin POST gets, and who calls it', async () => {
  const row = table('| Endpoint ')
    .split('\n')
    .find((l) => l.includes('`POST /api/leave`'))!

  // leave.ts refuses a foreign Origin with 403 BEFORE it reads the token, and
  // lets a request with no Origin through (originAllowed), so "always 204,
  // same-origin only" described neither half.
  const app = createApp(new Store())
  const created = await request(app)
    .post('/api/sessions')
    .send({ session_id: 'ses_leave_docs', directory: '/work', title: 't' })
  const joined = await request(app)
    .post('/api/activate')
    .send({ code: created.body.access_code, session_id: 'ses_leave_docs' })
  const token = viewerTokenFrom(joined)
  const cross = await request(app)
    .post('/api/leave')
    .set('Origin', 'https://evil.example')
    .set('Cookie', `viewer_token=${token}`)
  expect(cross.status, 'a cross-origin leave is no longer refused?').toBe(403)
  expect(row, 'the row still promises an unconditional 204').not.toMatch(/always `204`/)
  expect(row, 'the row does not name the 403 a cross-origin POST gets').toMatch(/403/)
  // A CLI sends no Origin at all and is accepted, so "same-origin only" overstates it.
  const noOrigin = await request(app).post('/api/leave').set('Cookie', `viewer_token=${token}`)
  expect(noOrigin.status).toBe(204)
  expect(row).not.toMatch(/Same-origin only/)
  expect(row, 'the row does not say what else the response clears').toContain('Clear-Site-Data')

  // "No page the relay serves calls it" — checked against the pages the relay
  // serves and injects into, not against prose. (The upstream UI bundle in
  // public/assets is not ours and knows nothing of this endpoint.)
  const second = await request(app)
    .post('/api/activate')
    .send({ code: created.body.access_code, session_id: 'ses_leave_docs' })
  const live = viewerTokenFrom(second)
  const pages = [
    (await request(app).get('/join')).text,
    (await request(app).get('/ses_leave_docs')).text,
    (await request(app).get('/ses_leave_docs').set('Cookie', `viewer_token=${live}`)).text,
    fs.readFileSync(fileURLToPath(new URL('../public/join.html', import.meta.url)), 'utf8'),
    fs.readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8'),
  ]
  const callers = pages.filter((page) => page.includes('/api/leave'))
  if (callers.length === 0) {
    expect(row, 'no page calls it, and the row does not say so').toMatch(/No page the relay serves calls it/)
  } else {
    expect(row, 'a page calls it now, and the row still says none does').not.toMatch(
      /No page the relay serves calls it/,
    )
  }
})

test('the /health row lists every field the probe body actually carries', async () => {
  const row = table('| Endpoint ')
    .split('\n')
    .find((l) => l.includes('`GET /health`'))!
  const res = await request(createApp(new Store())).get('/health')
  expect(res.status).toBe(200)
  for (const field of Object.keys(res.body)) {
    expect(row, `/health answers with "${field}" and the README's row does not name it`).toContain(field)
  }
  // The nested shape too: a monitor reading the body needs the key names.
  expect(fs.readFileSync(HEALTH, 'utf8'), 'health.ts no longer reports faults').toContain('faults: faults()')
  for (const field of ['swallowed', 'last_at']) {
    expect(fs.readFileSync(FAULTS, 'utf8')).toContain(field)
    expect(row, `faults carries "${field}" and the README's row does not name it`).toContain(field)
  }
  // And what the field must NOT be taken for: the probe stays green over one.
  expect(row).toMatch(/never moves `ok`\/`healthy`/)
})

/**
 * The one list that says what a viewer's live stream carries when the payload
 * names no session. It is a security boundary written in two places — the
 * adapter's GLOBAL_EVENT_KINDS and the README's table — and the README is what
 * an owner reads before handing out a code, so the two must not drift. Read
 * from the code, as the tests above are: a kind added to the allow-list is a
 * row the README has to grow.
 */
test('the README names exactly the unsessioned event kinds a viewer receives', () => {
  const adapter = fs.readFileSync(ADAPTER, 'utf8')
  const list = adapter.match(/const GLOBAL_EVENT_KINDS = new Set\(\[([^\]]*)\]\)/)
  expect(list, 'GLOBAL_EVENT_KINDS is no longer a literal Set in the adapter').not.toBeNull()
  const kinds = [...list![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
  expect(kinds.length).toBeGreaterThan(0)

  const rows = table('| Forwarded with no session id ')
  for (const kind of kinds) {
    expect(rows, `the adapter forwards "${kind}" and the README's table does not list it`).toContain('`' + kind + '`')
  }
  const listed = [...rows.matchAll(/^\| `([a-z.]+)` \|/gm)].map((m) => m[1]!)
  expect(listed.sort()).toEqual([...kinds].sort())

  // And the promise that goes with it: everything else is dropped, and a drop
  // is findable rather than silent.
  const readme = fs.readFileSync(README, 'utf8')
  expect(readme).toMatch(/Everything else carrying no session id is dropped/)
  expect(readme).toContain('events_dropped')
})
