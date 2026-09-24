import { afterAll, beforeAll, expect, test } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server'
import { Store } from '../src/store'

/**
 * The session API answers under the spelling nginx rate-limits, and no other.
 *
 * The edge's per-address throttle on registration is the vhost's
 * `location /api/sessions` with the oc_register zone (60 r/m, burst 10): a
 * prefix match, compared case-sensitively. express mounted the router with
 * app.use('/api/sessions'), which ignores case, so POST /API/sessions or
 * /api/Sessions registered a session (and GET /API/sessions/<id> answered)
 * while nginx sent those to `location /` and oc_general, 200 r/s with a burst
 * of 400. A caller refused by a full relay could then have it write a warning
 * to the log two hundred times a second from every address. Same bypass, and
 * the same cure, as /api/activate (see activate-canonical-path.test.ts).
 *
 * nginx is not run here. The first test reads which location carries
 * oc_register from the repo's vhost; the second sends raw request lines to the
 * relay, so no client library normalises the path on the way.
 */

const VHOST = fileURLToPath(new URL('../../nginx/opencode.b4tr.net.conf', import.meta.url))
const PREFIX = '/api/sessions'

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

/** Send `method` to `path` exactly as written, request line and all. */
function raw(
  method: string,
  path: string,
  ip: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          // Each registration from its own address, so no per-address cap is in play.
          'X-Forwarded-For': ip,
        },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

test("the vhost's registration throttle is a case-sensitive prefix location on the relay's spelling", () => {
  const vhost = fs.readFileSync(VHOST, 'utf8')
  const locations = [...vhost.matchAll(/^\s*location\s+(?:(=|\^~|~\*?)\s+)?(\S+)\s*\{([^}]*)\}/gm)]
  const throttled = locations.filter((m) => /\blimit_req\s+zone=oc_register\b/.test(m[3]))
  expect(throttled.map((m) => [m[1], m[2]])).toEqual([[undefined, PREFIX]])
})

test('only spellings under the prefix nginx throttles reach the session API; others are a 404', async () => {
  let n = 0
  const ip = () => `198.51.100.${++n}`
  // Spellings express routed to the session router that nginx's prefix
  // location does not match: it does not fold case, and on Linux it keeps a
  // backslash, which express's URL parser turns into `/` once the request
  // line carries `#`.
  const bypasses = ['/API/sessions', '/api/Sessions/', '/Api/Sessions?x=1', '/api\\sessions#x']
  for (const [i, path] of bypasses.entries()) {
    const res = await raw('POST', path, ip(), { session_id: `ses_bypass_${i}`, directory: '/work', title: 't' })
    expect.soft({ path, status: res.status }).toEqual({ path, status: 404 })
    expect.soft(JSON.parse(res.body), path).toEqual({ error: 'not found' })
    expect.soft(store.getSession(`ses_bypass_${i}`), path).toBeUndefined()
  }

  // What the bridge sends, with the variations nginx's prefix also covers.
  for (const [i, path] of [PREFIX, `${PREFIX}/`, `${PREFIX}?from=bridge`].entries()) {
    const res = await raw('POST', path, ip(), { session_id: `ses_canonical_${i}`, directory: '/work', title: 't' })
    expect({ path, status: res.status }).toEqual({ path, status: 201 })
  }
  const { bridge_token } = JSON.parse(
    (await raw('POST', PREFIX, ip(), { session_id: 'ses_status', directory: '/work', title: 't' })).body,
  ) as { bridge_token: string }

  // Presence and deletion live under the same prefix.
  expect((await raw('GET', '/API/sessions/ses_status', ip())).status).toBe(404)
  expect((await raw('DELETE', '/Api/sessions/ses_status', ip())).status).toBe(404)
  expect((await raw('GET', `${PREFIX}/ses_status`, ip())).status).toBe(200)
  const del = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'DELETE', path: `${PREFIX}/ses_status`, headers: { 'x-bridge-token': bridge_token } },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    req.on('error', reject)
    req.end()
  })
  expect(del).toBe(204)
})
