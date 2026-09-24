import { afterAll, beforeAll, expect, test } from 'vitest'
import request from 'supertest'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server'
import { Store } from '../src/store'

/**
 * Whether nginx compresses the static files the viewer UI actually downloads.
 *
 * The relay compresses nothing itself (express.static, no compression
 * middleware), so nginx's gzip is the only compression a viewer gets, and
 * nginx compresses a response only when its Content-Type, parameters dropped,
 * is exactly one of gzip_types (text/html is always included). The list was
 * written for the text bundles: JS, CSS, JSON, SVG, the manifest. But the UI's
 * text font, Inter, ships only as raw TrueType: /assets/Inter.ttf, 874,708
 * bytes, served as font/ttf and loaded on every page a viewer opens with an
 * empty cache (the UI's default layout sets its body text in Inter; measured
 * locally in Chromium, encodedBodySize = decodedBodySize = 874,708). It crossed
 * at full size although gzip at nginx's level 5 takes it to 457,403 bytes. The
 * favicons (image/x-icon, 15,086 bytes) were left out the same way and shrink
 * to 357.
 *
 * nginx is not run here: this reads gzip_types and gzip_min_length from the
 * repo's vhost and asks the relay's own static handler what Content-Type each
 * file goes out with, which is the pair nginx matches.
 *
 * Files already compressed (woff2, woff, png, mp4, aac: under 7% smaller
 * through gzip, measured on the UI build) are not required, and listing them
 * would only spend CPU. A clean checkout has no UI build (public/* is
 * gitignored), so the test brings a fixture with each extension, and a local
 * run that has the build also checks every type in it.
 */

const CONF = fileURLToPath(new URL('../../nginx/opencode.b4tr.net.conf', import.meta.url))
const PUBLIC = fileURLToPath(new URL('../public', import.meta.url))

// express.static types a file by its extension alone, so a fixture with the
// same extension goes out with the same Content-Type as the real file. Unique
// names: static-cache.test.ts creates and removes its own Inter.ttf in parallel.
const FIXTURES = [
  { stands_for: '/assets/Inter.ttf', url: '/assets/zz-gziptest-font.ttf' },
  { stands_for: '/favicon-v3.ico', url: '/zz-gziptest.ico' },
]
const created: string[] = []

beforeAll(() => {
  for (const { url } of FIXTURES) {
    const p = path.join(PUBLIC, url)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // Above gzip_min_length and compressible, so the sweep below covers it too.
    fs.writeFileSync(p, Buffer.alloc(8192, 'gzip_types fixture '))
    created.push(p)
  }
})
afterAll(() => {
  for (const p of created) fs.rmSync(p, { force: true })
})

function nginxGzip(): { compresses: (type: string) => boolean; minLength: number } {
  const conf = fs.readFileSync(CONF, 'utf8')
  const types = conf.match(/^\s*gzip_types\s+([^;]+);/m)
  const minLength = conf.match(/^\s*gzip_min_length\s+(\d+)\s*;/m)
  if (!types || !minLength) throw new Error(`gzip_types or gzip_min_length not found in ${CONF}`)
  const listed = new Set(['text/html', ...types[1].trim().toLowerCase().split(/\s+/)])
  return { compresses: (type) => listed.has('*') || listed.has(type), minLength: Number(minLength[1]) }
}

async function servedType(app: ReturnType<typeof createApp>, url: string): Promise<string> {
  const res = await request(app).head(url)
  expect(res.status, `HEAD ${url}`).toBe(200)
  return String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
}

test.each(FIXTURES)('$stands_for goes out with a type nginx compresses', async ({ stands_for, url }) => {
  const type = await servedType(createApp(new Store()), url)
  expect(nginxGzip().compresses(type), `${stands_for} is served as ${type}, which gzip_types does not list`).toBe(true)
})

test('every type in public/ that gzip would shrink by over 20% is listed in gzip_types', async () => {
  const app = createApp(new Store())
  const { compresses, minLength } = nginxGzip()
  const byExt = new Map<string, string[]>()
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else {
        let size: number
        try {
          size = fs.statSync(p).size
        } catch {
          continue // another test file's fixture, removed since readdir
        }
        // nginx leaves a body under gzip_min_length alone whatever its type.
        if (size < minLength) continue
        const ext = path.extname(p).toLowerCase()
        // Source maps are on disk but never served (static-sourcemaps.test.ts),
        // and neither are the HTML shells: the relay serves those itself, as
        // text/html, which nginx always compresses (shell-csp.test.ts).
        if (ext === '.map' || ext === '.html' || ext === '.htm') continue
        byExt.set(ext, [...(byExt.get(ext) ?? []), p])
      }
    }
  }
  walk(PUBLIC)

  const missed: string[] = []
  for (const [ext, files] of byExt) {
    const type = await servedType(app, '/' + path.relative(PUBLIC, files[0]).split(path.sep).join('/'))
    if (compresses(type)) continue
    let raw = 0
    let gz = 0
    for (const f of files) {
      const body = fs.readFileSync(f)
      raw += body.length
      gz += zlib.gzipSync(body, { level: 5 }).length
    }
    if (gz < raw * 0.8) missed.push(`${type} (${ext}: ${files.length} files, ${raw} -> ${gz} bytes)`)
  }
  expect(missed, 'served types gzip would shrink, absent from gzip_types').toEqual([])
})
