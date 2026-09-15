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
