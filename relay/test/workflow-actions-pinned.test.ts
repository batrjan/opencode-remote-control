import { expect, test } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Every third-party GitHub Action the workflows call must be pinned to a full
 * 40-hex commit SHA, not a mutable tag.
 *
 * A tag such as `@v4` or `@v1` — even a patch tag like `@v0.1.7` — is a movable
 * pointer the upstream owner can retarget at any time. deploy.yml hands
 * appleboy/scp-action and appleboy/ssh-action the production SSH_PRIVATE_KEY, so
 * a compromised or repointed tag would run attacker code with that key. Pinning
 * to a commit SHA freezes the exact bytes; a `# vX.Y.Z` comment on the same line
 * keeps the human-readable version.
 *
 * No runtime test is possible — these files only ever execute on GitHub's
 * runners — so this is a static check of the workflow YAML instead. It also
 * validates that each workflow parses as YAML.
 *
 * `./…` reusable-workflow references (deploy.yml calls ./.github/workflows/ci.yml)
 * are local, not third-party, and carry no ref to pin, so they are exempt.
 */

const WORKFLOWS = ['ci.yml', 'deploy.yml'].map((name) =>
  fileURLToPath(new URL(`../../.github/workflows/${name}`, import.meta.url)),
)

// `uses: owner/repo@ref` (optionally `owner/repo/subpath@ref`), capturing repo
// and ref. Local `uses: ./…` references never match (no `@`).
const USES = /^\s*(?:-\s*)?uses:\s*([\w.-]+\/[\w./-]+)@(\S+)/gm
const SHA40 = /^[0-9a-f]{40}$/

test.each(WORKFLOWS)('%s parses as YAML-ish and pins every action', (file) => {
  const text = fs.readFileSync(file, 'utf8')

  // Cheap YAML sanity: no tab indentation (YAML forbids tabs for indent) and at
  // least one job step. A full parser would need a dependency the repo lacks.
  expect(text.includes('\t'), `${file} contains a tab character`).toBe(false)
  expect(/^\s*uses:/m.test(text) || /^\s*run:/m.test(text), `${file} has no steps`).toBe(true)

  const unpinned: string[] = []
  for (const [, repo, ref] of text.matchAll(USES)) {
    if (!SHA40.test(ref)) unpinned.push(`${repo}@${ref}`)
  }
  expect(unpinned, `actions pinned to a mutable tag instead of a commit SHA`).toEqual([])
})

/**
 * A commit SHA freezes only what GitHub checks out. It says nothing about what
 * that code then fetches on the runner: appleboy/scp-action@917f8b81 is a
 * docker action whose Dockerfile starts `FROM ghcr.io/appleboy/drone-scp:1.6.14`
 * — a movable tag — and appleboy/ssh-action@0ff4204d downloads a drone-ssh
 * release tarball with no checksum from a release marked mutable. Both steps
 * were handed the production SSH_PRIVATE_KEY, and that key's user is in the
 * docker group on the relay host. Plain ssh/scp keeps the key inside steps this
 * repository can read end to end; a docker action pinned by image digest would
 * be the other acceptable answer, so it is allowed here.
 */
const DEPLOY = WORKFLOWS[1]

/**
 * A workflow's steps as raw text, split at the `- ` that opens each one — with
 * the comment block above a step counted as part of it, since this file
 * explains a step in the lines before it and those lines are not the previous
 * step's.
 */
function steps(file: string): string[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s+-\s+(?:name|uses|run|id):/.test(lines[i])) continue
    let from = i
    while (from > 0 && /^\s*(?:#|$)/.test(lines[from - 1])) from--
    starts.push(from)
  }
  return starts.map((start, i) => lines.slice(start, starts[i + 1] ?? lines.length).join('\n'))
}

/** The shell body of a step's `run:`, block scalar or inline; '' when it has none. */
function runBody(step: string): string {
  const m = step.match(/^([ \t]*)run:[ \t]*(\|[-+]?|>[-+]?)?[ \t]*(.*)$/m)
  if (!m) return ''
  if (!m[2]) return m[3]
  const indent = m[1].length
  const body: string[] = []
  for (const line of step.slice(m.index! + m[0].length).split('\n')) {
    if (line.trim() === '') continue
    if (line.length - line.trimStart().length <= indent) break
    body.push(line)
  }
  return body.join('\n')
}

test('no step handed the deploy key runs third-party code', () => {
  for (const step of steps(DEPLOY)) {
    if (!step.includes('SSH_PRIVATE_KEY')) continue
    const uses = step.match(/^\s*(?:-\s*)?uses:\s*(\S+)/m)?.[1]
    if (uses === undefined) continue
    // The one exception: a docker action pinned by image digest is as frozen as
    // the checkout is, since the digest names the exact image layers.
    expect(uses, 'third-party action in a step that sees SSH_PRIVATE_KEY').toMatch(
      /^docker:\/\/\S+@sha256:[0-9a-f]{64}$/,
    )
  }
})

test('the deploy verifies the relay host key instead of trusting the first answer', () => {
  const text = fs.readFileSync(DEPLOY, 'utf8')
  expect(text, 'the deploy no longer reaches the host over ssh at all?').toMatch(/\bs(?:sh|cp)\b/)
  expect(text, 'no pinned host key: a MITM on the first connect gets the deploy key').toMatch(
    /secrets\.SSH_KNOWN_HOSTS/,
  )
  expect(text).toMatch(/StrictHostKeyChecking[ =]yes/)
  expect(text).not.toMatch(/StrictHostKeyChecking[ =](?:no|accept-new)/)
})

test('the pinned host key is matched by its KEY, not by how the operator spelled the host', () => {
  // The first real deploy failed here: the secret was scanned by hostname while
  // SSH_HOST names the same machine another way, and ssh looked the key up by
  // the name it was connecting to — "No ED25519 host key is known for ... and
  // you have requested strict checking". Nothing was wrong with the key.
  //
  // So the entry is re-keyed to the alias every ssh/scp in this workflow uses,
  // and the alias is what the lookup goes by. What is pinned is unchanged: the
  // key material the operator vouched for, with StrictHostKeyChecking yes.
  const text = fs.readFileSync(DEPLOY, 'utf8')
  expect(text, 'the known_hosts entry is not re-keyed to the alias').toMatch(/HostKeyAlias relay-host/)
  expect(text, 'the operator’s spelling is written through unchanged').toMatch(/\$1 = "relay-host"/)
  // And a secret with no usable key line must stop the deploy, like an empty
  // one does — otherwise the re-key quietly produces an empty file and ssh
  // fails later with a message about the host rather than about the secret.
  expect(text, 'a secret with no key line is not refused').toMatch(/no usable host key line/i)
})

// checkov CKV2_GHA_1. Job-level blocks already exist, but a job added later
// inherits the workflow default, and the default without this line is whatever
// the repository is configured with — historically write-all.
test.each(WORKFLOWS)('%s sets a workflow-level permissions block', (file) => {
  expect(/^permissions:/m.test(fs.readFileSync(file, 'utf8'))).toBe(true)
})

// Event data interpolated into a shell script is the classic workflow
// injection: `${{ github.* }}` is pasted in before the shell sees it, so a
// branch or title carrying a quote runs commands as the runner. Values the
// workflow itself defines (`matrix.*`) are fixed text and stay allowed.
test.each(WORKFLOWS)('%s keeps event data out of shell scripts', (file) => {
  const injected: string[] = []
  for (const step of steps(file)) {
    for (const m of runBody(step).matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)) {
      if (!/^matrix\./.test(m[1])) injected.push(m[1])
    }
  }
  expect(injected, 'interpolated into run: instead of passed through env:').toEqual([])
})

/**
 * A job with no `timeout-minutes` runs for GitHub's default of 360 minutes.
 * That is a queue problem here rather than a billing one: the deploy job holds
 * the `deploy-relay` concurrency group, and it reaches the host with plain
 * ssh/scp, which will sit for ever on a peer that keeps answering TCP while the
 * remote command hangs (a wedged build, a full disk, a host mid-reboot). Every
 * push behind it waits. ci.yml is in the same sentence because deploy.yml gates
 * on it.
 */
const JOB = /^ {2}([\w-]+):\n(?:(?: {4}.*)?\n)*/gm

test.each(WORKFLOWS)('%s bounds how long each of its jobs may run', (file) => {
  const text = fs.readFileSync(file, 'utf8')
  const unbounded: string[] = []
  const tooLong: string[] = []
  const jobsAt = text.search(/^jobs:$/m)
  expect(jobsAt, `${file} has no jobs: block`).toBeGreaterThan(-1)
  for (const [block, name] of text.slice(jobsAt).matchAll(JOB)) {
    // A job that only calls a reusable workflow inherits that workflow's own
    // timeouts, which this same test checks over there.
    if (/^ {4}uses:\s*\.\//m.test(block)) continue
    const minutes = block.match(/^ {4}timeout-minutes:\s*(\d+)\s*$/m)
    if (!minutes) unbounded.push(name)
    else if (Number(minutes[1]) > 60) tooLong.push(`${name}=${minutes[1]}`)
  }
  expect(unbounded, 'jobs with no timeout-minutes run for GitHub\'s 360-minute default').toEqual([])
  expect(tooLong, 'a timeout this long is not a bound on a held concurrency group').toEqual([])
})

test('the relay-host ssh alias sets its own connect and keepalive bounds', () => {
  const block = fs.readFileSync(DEPLOY, 'utf8').match(/^ {10}Host relay-host\n(?:^ {12}.*\n)+/m)
  expect(block, 'the Host relay-host block in the ssh config the deploy writes').not.toBeNull()
  // Not left to the defaults: ubuntu-latest's `BatchMode yes` brings a
  // Debian-specific ServerAliveInterval of 300, and on a runner image without
  // that patch it is 0 — no keepalive at all.
  for (const option of ['ConnectTimeout', 'ServerAliveInterval', 'ServerAliveCountMax']) {
    expect(block![0], `${option} is not set on the alias every ssh/scp uses`).toMatch(
      new RegExp(`^\\s*${option}\\s+\\d+$`, 'm'),
    )
  }
})
