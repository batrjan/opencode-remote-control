import { afterAll, beforeAll, expect, test } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server'
import { Store } from '../src/store'

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

/**
 * Activation answers under the one spelling nginx rate-limits, and no other.
 *
 * The edge's per-address throttle on code guessing is the vhost's
 * `location = /api/activate` with the oc_activate zone (120 r/m, burst 40).
 * That is nginx's exact match, compared case-sensitively against the path.
 * express mounted the route with app.use('/api/activate'), which ignores case
 * and a trailing slash, so POST /API/activate, /api/activate/, /Api/Activate/
 * and /api/activate// (and, through express's URL parser, /api\activate#x)
 * all exchanged a code for a viewer cookie — while nginx sent every one of
 * them to `location /` and oc_general, 200 r/s with a burst of 400. DEPLOY.md
 * and the zones file described a throttle any caller could step around by
 * changing one letter. The share's own lock still bounded the guessing, but
 * the edge shield in front of it was not there.
 *
 * nginx is not run here. The first test reads which location carries
 * oc_activate from the repo's vhost; the second sends raw request lines to the
 * relay, so no client library normalises the path on the way.
 */

const VHOST = fileURLToPath(new URL('../../nginx/opencode.b4tr.net.conf', import.meta.url))
const CANONICAL = '/api/activate'

let store: Store
let server: http.Server
let port: number

beforeAll(async () => {
  store = new Store()
  server = http.createServer(createApp(store))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

/** POST a JSON body to `path` exactly as written, request line and all. */
function rawPost(path: string, body: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

test("the vhost's activation throttle is an exact-match location on the relay's spelling", () => {
  const vhost = fs.readFileSync(VHOST, 'utf8')
  const locations = [...vhost.matchAll(/^\s*location\s+(?:(=|\^~|~\*?)\s+)?(\S+)\s*\{([^}]*)\}/gm)]
  const throttled = locations.filter((m) => /\blimit_req\s+zone=oc_activate\b/.test(m[3]))
  expect(throttled.map((m) => [m[1], m[2]])).toEqual([['=', CANONICAL]])
})

test('only the exact path nginx throttles activates; every other spelling is a 404 and sets no cookie', async () => {
  // Spellings express routed to the activation handler, none of which nginx's
  // `location = /api/activate` matches (nginx merges `//` into `/`, which
  // still leaves a trailing slash, and it does not fold case). The last one is
  // express's URL parser: a request line carrying `#` goes through url.parse,
  // which turns `\` into `/`; nginx on Linux keeps the backslash in the path.
  const bypasses = ['/API/activate', '/api/activate/', '/Api/Activate/', '/api/activate//', '/api/ACTIVATE?x=1', '/api\\activate#x']
  for (const [i, path] of bypasses.entries()) {
    const id = `ses_spelling_${i}`
    const { access_code } = store.createSession(id, '/work', 't', '203.0.113.1')
    const res = await rawPost(path, { code: access_code, session_id: id })
    expect.soft({ path, status: res.status, cookie: res.headers['set-cookie'] }).toEqual({ path, status: 404, cookie: undefined })
    expect.soft(JSON.parse(res.body), path).toEqual({ error: 'not found' })
  }

  // The spelling the join page posts to, with or without a query string (nginx
  // matches locations on the path alone), is unchanged.
  for (const [i, path] of [CANONICAL, `${CANONICAL}?from=join`].entries()) {
    const id = `ses_canonical_${i}`
    const { access_code } = store.createSession(id, '/work', 't', '203.0.113.1')
    const res = await rawPost(path, { code: access_code, session_id: id })
    expect({ path, status: res.status }).toEqual({ path, status: 200 })
    expect(res.headers['set-cookie']?.some((c) => c.startsWith('viewer_token='))).toBe(true)
  }
})
