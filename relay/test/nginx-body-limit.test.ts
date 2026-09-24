import { expect, test } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { proxyBodyLimitBytes } from '../src/config'

/**
 * What the edge spools to disk before the relay can refuse it.
 *
 * nginx buffers a request body whole (proxy_request_buffering is on by default,
 * and nothing here turns it off), so `client_max_body_size` is the real bound
 * on what one request costs the HOST — and it sat at 32m while the largest body
 * the relay accepts is 25 MiB. The seven megabytes in between bought nothing:
 * nginx spooled them and the relay answered 413 for exactly the same request.
 *
 * nginx is not run here; this checks the repo's vhost against the relay's own
 * limit, and the DEPLOY.md row that quotes it, so the three cannot drift.
 */

const CONF = fileURLToPath(new URL('../../nginx/opencode.b4tr.net.conf', import.meta.url))
const DEPLOY = fileURLToPath(new URL('../../DEPLOY.md', import.meta.url))
const MiB = 1024 * 1024

/** `client_max_body_size` directives, outermost first, with their nesting depth. */
function bodySizes(conf: string): { size: string; depth: number }[] {
  const found: { size: string; depth: number }[] = []
  let depth = 0
  for (const raw of conf.split('\n')) {
    const line = raw.replace(/#.*$/, '')
    const directive = /client_max_body_size\s+([^;]+);/.exec(line)
    if (directive) found.push({ size: directive[1].trim(), depth })
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
  }
  return found
}

test('the edge admits exactly what the relay will accept, and no more', () => {
  const conf = fs.readFileSync(CONF, 'utf8')
  const sizes = bodySizes(conf)
  expect(sizes.length, 'no client_max_body_size at all in the vhost').toBeGreaterThan(0)

  // The server-level one (depth 1) is what a proxied POST gets.
  const server = sizes.filter((s) => s.depth === 1)
  expect(server.length, 'exactly one server-level client_max_body_size').toBe(1)
  expect(server[0].size, "the edge's limit is not the relay's own").toBe(`${proxyBodyLimitBytes() / MiB}m`)

  // The public endpoints are cut the other way and must stay there: a
  // registration is a few hundred bytes.
  for (const inner of sizes.filter((s) => s.depth > 1)) {
    expect(inner.size, 'a location now admits more than the public endpoints need').toBe('64k')
  }
})

test('the runbook quotes the body size the vhost actually sets', () => {
  const conf = fs.readFileSync(CONF, 'utf8')
  const server = bodySizes(conf).find((s) => s.depth === 1)!
  const row = fs
    .readFileSync(DEPLOY, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('| `client_max_body_size'))
  expect(row, 'a DEPLOY.md row for client_max_body_size').toBeDefined()
  expect(row!, "the runbook still quotes the vhost's old body size").toContain(`client_max_body_size ${server.size}`)
})
