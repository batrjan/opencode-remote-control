import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

/**
 * The committed bundle must be built from a real checkout, not through a
 * symlink.
 *
 * esbuild writes each module's path into the bundle as a comment, relative to
 * the output. Built in a git worktree whose bridge/node_modules is a symlink to
 * another checkout — which is how agents share dependencies — every one of
 * those comments comes out as `../../../../bridge/node_modules/…` instead of
 * `node_modules/…`. The bundle RUNS either way, so nothing local catches it:
 * the suites pass, `npm run bundle` reports no drift against the file it just
 * wrote, and the difference only surfaces on CI, whose checkout has no symlink
 * and whose rebuild therefore disagrees with what was committed. That cost a
 * red pipeline on main.
 */
test('the committed bundle names its modules from the package root', () => {
  const bundle = readFileSync(new URL('../../plugin/bridge/remote-control-bridge.cjs', import.meta.url), 'utf8')
  const escaped = [...bundle.matchAll(/^\/\/ (\.\.\/.*)$/gm)].map((m) => m[1])
  expect(
    [...new Set(escaped)].slice(0, 5),
    'module paths point outside the package: the bundle was built through a symlinked node_modules',
  ).toEqual([])
})
