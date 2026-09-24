import { expect, test } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * How a Node-hosted opencode finds this plugin's entry.
 *
 * Under Bun — which is every opencode CLI: the TUI, `serve`, `run`, `mini`,
 * `acp`, `attach` — the loader resolves the installed directory itself. Under
 * Node it cannot: `import(<dir>)` throws ERR_UNSUPPORTED_DIR_IMPORT, so
 * opencode 1.18.32 asks Node to resolve the package BY NAME from inside the
 * package, `createRequire(<dir>/package.json).resolve("<bare name>")`, which is
 * an ordinary self-reference and needs a "." key in `exports`. This package had
 * only "./tui" and "./server", so the resolve threw ERR_PACKAGE_PATH_NOT_EXPORTED,
 * the loader took the undefined it was handed and returned, and `/remote-control`
 * simply did not exist in that process — the desktop app's Node sidecar, which
 * is what upstream calls that path in its own test.
 *
 * The two manifests are separate on purpose: the repo root is what a
 * `git+https://…` install resolves, and plugin/package.json is what an npm
 * publish of the plugin directory would. Both must answer the bare name, and
 * both must answer it with the SERVER entry — a module may export server() or
 * tui(), never both, and the server entry is the one a host without a TUI needs.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const NAME = 'opencode-remote-control'

/** Exactly what opencode does under Node, for a package installed at `dir`. */
function resolveLikeOpencode(dir: string): string {
  return createRequire(join(dir, 'package.json')).resolve(NAME)
}

const SERVER_ENTRY = fileURLToPath(new URL('../../plugin/server.js', import.meta.url))
const TUI_ENTRY = fileURLToPath(new URL('../../plugin/remote-control.js', import.meta.url))

test('a Node-hosted opencode resolves the bare package name from the repo root', () => {
  expect(resolveLikeOpencode(ROOT)).toBe(SERVER_ENTRY)
})

test('the same resolve works inside the plugin directory an npm publish would ship', () => {
  expect(resolveLikeOpencode(join(ROOT, 'plugin'))).toBe(SERVER_ENTRY)
})

/** The named subpaths are the documented way in and must not move. */
test('the explicit subpaths still resolve to the two entries', () => {
  const require = createRequire(join(ROOT, 'package.json'))
  expect(require.resolve(`${NAME}/server`)).toBe(SERVER_ENTRY)
  expect(require.resolve(`${NAME}/tui`)).toBe(TUI_ENTRY)
})

test('both manifests point "." at the server entry, not the TUI one', () => {
  for (const path of ['../../package.json', '../../plugin/package.json']) {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'))
    expect(pkg.name, `${path} must keep the name the host resolves`).toBe(NAME)
    expect(pkg.exports['.'], `${path} has no "." export for a Node host to resolve`).toBeDefined()
    expect(pkg.exports['.'], `${path} points "." at something other than the server entry`).toBe(
      pkg.exports['./server'],
    )
  }
})

/** And it must actually load: a resolve that points at nothing is no better. */
test('the resolved entry is the server plugin module', async () => {
  const mod = await import(resolveLikeOpencode(ROOT))
  expect(typeof mod.default.server).toBe('function')
  expect('tui' in mod.default).toBe(false)
  expect(mod.default.id).toBe('remote-control')
})
