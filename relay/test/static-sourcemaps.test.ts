import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * The UI build's source maps are not handed out.
 *
 * express.static served everything in public/, and the upstream Vite build
 * leaves a .js.map beside every bundle in /assets: 835 files, about 48 MB, one
 * of them 11.5 MB. Measured against a local relay, every one of them came back
 * 200 to a client with no cookie at all, so anyone could make the host read,
 * send and (through nginx's gzip of application/json) compress 11.5 MB per
 * request. Nothing in the viewer uses them: a real page load in Chromium asked
 * for none, and the UI never fetches one (browsers do so only with DevTools
 * open). What they hold is the public upstream source, so this is weight and
 * bandwidth, not a secret.
 *
 * The static handler now passes on a request whose decoded path names a .map,
 * and it ends at the relay's JSON 404 like any other missing file. Decoded,
 * because the handler decodes before it looks on disk: /assets/x.js%2Emap is
 * the same file. Only static serving is skipped, so an API route whose query
 * happens to name a .map (the file tree's /file?path=...) still reaches the
 * bridge.
 */

// public/assets is gitignored, so a CI checkout has no UI build: the test
// brings its own bundle and map, named apart from other tests' fixtures, and
// removes only what it made.
const ASSETS = fileURLToPath(new URL('../public/assets', import.meta.url))
const BUNDLE = 'zz-maptest-Ab3_x9Z1.js'
const MAP = `${BUNDLE}.map`
const created: string[] = []

beforeAll(() => {
  fs.mkdirSync(ASSETS, { recursive: true })
  const files: Array<[string, string]> = [
    [BUNDLE, `console.log(1)\n//# sourceMappingURL=${MAP}\n`],
    [MAP, '{"version":3,"sources":[],"mappings":""}'],
  ]
  for (const [name, body] of files) {
    const p = path.join(ASSETS, name)
    fs.writeFileSync(p, body)
    created.push(p)
  }
})
afterAll(() => {
  for (const p of created) fs.rmSync(p, { force: true })
})

test('a source map is not served, with no cookie or otherwise', async () => {
  const app = createApp(new Store())
  const res = await request(app).get(`/assets/${MAP}`)
  expect(res.status).toBe(404)
  expect(res.body).toEqual({ error: 'not found' })
  expect(res.text).not.toContain('"version"')
})

test('nor under a spelling the static handler decodes to the same file', async () => {
  const app = createApp(new Store())
  const dotAt = MAP.lastIndexOf('.')
  for (const url of [
    `/assets/${MAP.slice(0, dotAt)}%2Emap`,
    `/assets/${MAP.slice(0, dotAt)}%2emap`,
    `/assets/${MAP.slice(0, dotAt)}.m%61p`,
    `/%61ssets/${MAP}`,
    `/assets/../assets/${MAP}`,
    // The same file only on a case-insensitive filesystem (a macOS checkout).
    `/assets/${MAP.slice(0, dotAt)}.MAP`,
  ]) {
    const res = await request(app).get(url)
    expect({ url, status: res.status, map: res.text.includes('"version"') }).toEqual({ url, status: 404, map: false })
  }
  // A HEAD as well: the 11.5 MB is the point, but a 200 would still say the map is there.
  const head = await request(app).head(`/assets/${MAP}`)
  expect(head.status).toBe(404)
})

test('the bundle that names the map is still served as JavaScript', async () => {
  const app = createApp(new Store())
  const res = await request(app).get(`/assets/${BUNDLE}`)
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toMatch(/javascript/)
  expect(res.text).toContain(`sourceMappingURL=${MAP}`)
})

test('with the proxy mounted as in production, a viewer is refused the map too, and an API query naming a .map still reaches the bridge', async () => {
  const store = new Store()
  const server = http.createServer()
  const links = new BridgeClient(server, store)
  const forwarded = vi
    .spyOn(links, 'request')
    .mockResolvedValue({ status: 200, contentType: 'application/json', body: '{"type":"raw","content":"{}"}' })
  const app = createApp(store, links)
  try {
    const { access_code } = store.createSession('ses_maptest', '/work', 't', '127.0.0.1')
    const { viewer_token } = store.activate(access_code, 'ses_maptest')
    const cookie = `viewer_token=${viewer_token}`
    const map = await request(app).get(`/assets/${MAP}`).set('Cookie', cookie)
    expect(map.status).toBe(404)
    expect(map.body).toEqual({ error: 'not found' })
    expect(forwarded).not.toHaveBeenCalled()

    const res = await request(app).get('/file/content?path=dist/app.js.map').set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(forwarded).toHaveBeenCalledTimes(1)
    expect(forwarded.mock.calls[0]![1].path).toContain('app.js.map')
  } finally {
    links.close()
  }
})
