import { afterAll, beforeAll, expect, test } from 'vitest'
import request from 'supertest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server'
import { Store } from '../src/store'

/**
 * How long a browser may keep the UI's static files without asking again.
 *
 * express.static was mounted with no options, so every file it served went out
 * as "Cache-Control: public, max-age=0": stale the moment it arrived. Measured
 * in Chromium against a local relay, a second load of the UI sent a
 * conditional request for each of its static files (the 2.7 MB bundle, its CSS,
 * the fonts, the manifest, the lazy chunks) and waited for a 304 on each, one
 * round trip apiece, on every navigation and reload. Worse, the ETag is built
 * from size and mtime, and the image copies the UI build into place at build
 * time: a rebuilt layer gives every byte-identical file a new mtime, and every
 * returning viewer then downloads all of it again, about 4 MB for a boot.
 *
 * The UI's build names its files in /assets after their content (Vite's
 * -[hash8] suffix), so a file under a given name never changes: those can be
 * kept for a year. Two files in /assets are copied verbatim without a hash
 * (Inter.ttf and the JetBrains Mono woff2, referenced by fixed URL from the
 * CSS), and everything at the root and the HTML shells can change under the
 * same name — those must keep revalidating, or a viewer would never see the
 * new hashed names a deploy brings.
 */

// public/assets is gitignored, so a CI checkout has no UI build: the test
// brings its own fixtures (Vite-style hashed names and the two unhashed fonts
// the upstream CSS references by fixed URL), and removes only what it made.
const ASSETS = fileURLToPath(new URL('../public/assets', import.meta.url))
const FIXTURES = {
  hashedJs: 'zz-cachetest-Ab3_x9Z-.js',
  hashedCss: 'zz-cachetest-Q1w2E3r4.css',
  inter: 'Inter.ttf',
  mono: 'JetBrainsMonoNerdFontMono-Regular.woff2',
}
const created: string[] = []

beforeAll(() => {
  fs.mkdirSync(ASSETS, { recursive: true })
  for (const name of Object.values(FIXTURES)) {
    const p = path.join(ASSETS, name)
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, 'x')
      created.push(p)
    }
  }
})
afterAll(() => {
  for (const p of created) fs.rmSync(p, { force: true })
})

test('content-hashed /assets files are cacheable for a year and immutable', async () => {
  const app = createApp(new Store())
  for (const name of [FIXTURES.hashedJs, FIXTURES.hashedCss]) {
    const res = await request(app).get(`/assets/${name}`)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toMatch(/max-age=31536000/)
    expect(res.headers['cache-control']).toMatch(/immutable/)
  }
})

test('unhashed fonts and root files keep revalidating (never immutable)', async () => {
  const app = createApp(new Store())
  for (const url of [`/assets/${FIXTURES.inter}`, `/assets/${FIXTURES.mono}`, '/join.html', '/index.html']) {
    const res = await request(app).get(url)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control'] ?? '').not.toMatch(/immutable/)
    expect(res.headers['cache-control'] ?? '').not.toMatch(/max-age=[1-9]/)
  }
})

test('a missing hashed asset is not answered with a cacheable response', async () => {
  // A viewer holding an old shell during a deploy asks for a name that is gone:
  // the 404 must not be kept for a year.
  const app = createApp(new Store())
  const res = await request(app).get('/assets/zz-cachetest-Missing0.js')
  expect(res.status).toBe(404)
  expect(res.headers['cache-control'] ?? '').not.toMatch(/max-age=[1-9]|immutable/)
})

test('the HTML shells are never given a long max-age', async () => {
  const app = createApp(new Store())
  const res = await request(app).get('/terminal')
  expect(res.status).toBe(200)
  expect(res.headers['cache-control'] ?? '').not.toMatch(/max-age=[1-9]/)
})
