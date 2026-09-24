import { expect, test } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * What the production image is built FROM, and what it carries at runtime.
 *
 * All three stages said `FROM node:22-slim` — a tag, resolved by whatever the
 * relay host's daemon had cached. Thirty-one deploy logs across eleven days
 * show the same base layer id and not one `Pulling from library/node`, so a
 * Node or Debian patch had no path into production at all. A trivy scan of the
 * running image found 225 OS CVEs (4 CRITICAL) plus 19 in the npm CLI that
 * ships inside the base image — npm the relay never runs: the CMD and the
 * HEALTHCHECK are plain `node`, and the app's own node_modules scanned clean.
 *
 * Docker is not installed here (test/docker.test.ts, the one test that builds
 * the image, self-skips for exactly that reason and CI excludes it), so this
 * reads the Dockerfile and the deploy workflow instead.
 */

const DOCKERFILE = fileURLToPath(new URL('../Dockerfile', import.meta.url))
const DEPLOY_WORKFLOW = fileURLToPath(new URL('../../.github/workflows/deploy.yml', import.meta.url))

/** The Dockerfile's stages, each starting at its own FROM. */
function stages(): string[] {
  const text = fs.readFileSync(DOCKERFILE, 'utf8')
  const starts = [...text.matchAll(/^FROM\s/gm)].map((m) => m.index!)
  return starts.map((start, i) => text.slice(start, starts[i + 1] ?? text.length))
}

test('every node stage is pinned by digest, from one ARG the stages share', () => {
  const text = fs.readFileSync(DOCKERFILE, 'utf8')
  const bases = [...text.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1])
  const node = bases.filter((b) => /node:/.test(b) || /NODE_IMAGE/.test(b))
  expect(node.length, 'no node stage found — has the Dockerfile been rewritten?').toBeGreaterThan(0)
  for (const base of node) {
    expect(base, 'a node stage not on the shared pinned base').toMatch(/^\$\{NODE_IMAGE\}$/)
  }

  // One declaration, so two stages can never end up on different bases.
  const pins = [...text.matchAll(/^ARG\s+NODE_IMAGE=(\S+)/gm)].map((m) => m[1])
  expect(pins).toHaveLength(1)
  expect(pins[0], 'the base is a movable tag, not a digest').toMatch(/^node:[\w.-]+@sha256:[0-9a-f]{64}$/)
})

test('the deploy fetches the pinned base instead of reusing whatever is cached', () => {
  const text = fs.readFileSync(DEPLOY_WORKFLOW, 'utf8')
  expect(text, 'docker build without --pull: a digest that is never fetched is not a pin').toMatch(
    /docker build[^\n]*--pull/,
  )
})

test('the runtime image ships neither npm nor a stale apt tree', () => {
  const final = stages().at(-1)!
  expect(final, 'npm left in the final image').toMatch(/rm -rf[^]*?node_modules\/npm/)
  expect(final, 'corepack left in the final image').toMatch(/corepack/)
  expect(final, 'no apt-get upgrade, so the digest pin freezes the OS CVEs too').toMatch(
    /apt-get\s+(?:-y\s+)?upgrade/,
  )
})

test('the build frontend is pinned by digest, or not requested at all', () => {
  // A `# syntax=` directive is resolved BEFORE the build starts and outside
  // `--pull`, by the daemon on the production host, and what it names then
  // parses everything else — so a movable tag there is the least visible and
  // earliest-running link in the chain.
  const first = fs.readFileSync(DOCKERFILE, 'utf8').split('\n')[0]
  const syntax = first.match(/^#\s*syntax\s*=\s*(\S+)/)?.[1]
  if (syntax === undefined) {
    // Not requested: BuildKit's builtin dockerfile.v0 parses the file, which is
    // only true while the file uses nothing frontend-specific.
    const text = fs.readFileSync(DOCKERFILE, 'utf8')
    for (const feature of [/^RUN\s+--mount/m, /^COPY\s+--link/m, /^ADD\s+--checksum/m, /<<-?[A-Za-z]/, /^#\s*check=/m]) {
      expect(text, `a frontend-specific feature (${feature.source}) with no # syntax= directive`).not.toMatch(feature)
    }
    return
  }
  expect(syntax, 'the build frontend is a movable tag, not a digest').toMatch(/@sha256:[0-9a-f]{64}$/)
})

test('the docs do not promise OS patches that the layer cache never delivers', () => {
  const dockerfile = fs.readFileSync(DOCKERFILE, 'utf8')
  const deployWorkflow = fs.readFileSync(DEPLOY_WORKFLOW, 'utf8')
  const runbook = fs.readFileSync(fileURLToPath(new URL('../../DEPLOY.md', import.meta.url)), 'utf8')

  // The final stage's `apt-get upgrade` re-runs only when something above it
  // changes. Between digest bumps nothing does, and the deploy keeps the layer
  // cache on purpose — so the only way a build could pick up OS patches is a
  // cache-buster declared before the RUN and passed by the deploy.
  const final = stages().at(-1)!
  const aptAt = final.search(/^RUN[^\n]*apt-get/m)
  expect(aptAt, 'no apt-get in the final stage').toBeGreaterThan(-1)
  const busted =
    /^ARG\s+APT_REFRESH/m.test(final.slice(0, aptAt)) &&
    /docker build[^\n]*--build-arg\s+APT_REFRESH=/.test(deployWorkflow)

  if (busted) return
  for (const [name, text] of [
    ['relay/Dockerfile', dockerfile],
    ['DEPLOY.md', runbook],
  ] as const) {
    expect(text, `${name} claims the upgrade keeps the base current between bumps, but that layer is a cache hit`)
      .not.toMatch(/current\s+(?:in\s+)?between\s+(?:pin\s+)?bumps/i)
  }
})

test('a Dependabot docker entry, if one exists, can actually see this base image', () => {
  const config = fileURLToPath(new URL('../../.github/dependabot.yml', import.meta.url))
  if (!fs.existsSync(config)) return // documented as a manual bump instead
  const text = fs.readFileSync(config, 'utf8')
  if (!/package-ecosystem:\s*["']?docker/.test(text)) return

  // Dependabot's docker updater reads literal FROM lines and does not resolve
  // build args, so `FROM ${NODE_IMAGE}` is invisible to it: an entry against
  // this Dockerfile would find nothing for ever and say nothing about it.
  const bases = [...fs.readFileSync(DOCKERFILE, 'utf8').matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1])
  expect(
    bases.some((base) => /^[\w.\-/]+:[\w.-]+(@sha256:[0-9a-f]{64})?$/.test(base)),
    'a docker ecosystem entry against a Dockerfile whose bases are all build args updates nothing',
  ).toBe(true)
})
