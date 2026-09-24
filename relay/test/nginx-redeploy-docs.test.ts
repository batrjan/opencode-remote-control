import { expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Whether the runbook admits that `nginx/` is delivered by nobody.
 *
 * The deploy ships `relay/` and nothing else, and of that the host uses only
 * docker-compose.yml: no step copies, tests or reloads an nginx config. The
 * section describing the install was headed "nginx (one-time)", which reads as
 * bootstrap-and-forget — so the edge shield this branch adds to `location =
 * /bridge` was written, reviewed, merged and deployed green while production
 * went on answering /bridge from express. (Checked on the host: the installed
 * vhost still said "Never rate-limited" and /etc/nginx/conf.d held no
 * oc_bridge zone.)
 *
 * nginx is not run here, so this checks the two documents against each other
 * and against the repo's own nginx/ tree: the premise (nothing ships it), the
 * heading, the Deploy checklist, and that every file under nginx/ is named
 * where the install instructions are — so a third config file cannot be added
 * without the runbook saying how it gets to the host.
 */

const DEPLOY = fileURLToPath(new URL('../../DEPLOY.md', import.meta.url))
const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/deploy.yml', import.meta.url))
const NGINX_DIR = fileURLToPath(new URL('../../nginx', import.meta.url))

/** Repo-relative paths of every config under nginx/. */
function nginxFiles(dir = NGINX_DIR): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return nginxFiles(full)
    return entry.isFile() ? [path.relative(path.dirname(NGINX_DIR), full)] : []
  })
}

/** A markdown section: its `## ` heading through the next one. */
function section(markdown: string, heading: RegExp): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => /^## /.test(l) && heading.test(l))
  expect(start, `a "## " section matching ${heading}`).toBeGreaterThan(-1)
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

test('nothing in the pipeline ships nginx/, so the runbook must own that step', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8')
  // The premise. If a deploy ever does deliver nginx/, this fails first and the
  // prose below has to be rewritten rather than quietly left wrong.
  const copies = [...workflow.matchAll(/^\s*(?:scp|rsync)\b.*$/gm)].map((m) => m[0])
  expect(copies.length, 'no scp/rsync at all — how does the build context reach the host?').toBeGreaterThan(0)
  expect(copies.join('\n'), 'a deploy step now ships nginx/: rewrite the nginx section').not.toMatch(/nginx/)

  const deploy = fs.readFileSync(DEPLOY, 'utf8')
  // Not "one-time": it is install AND update, by hand, every time.
  expect(deploy, 'the nginx section still reads as a one-time bootstrap').not.toMatch(/^## nginx \(one-time\)\s*$/m)
  // And the deploy runbook has to name it, or nobody reading the release
  // procedure learns that the release is incomplete.
  expect(section(deploy, /Deploy/), 'the Deploy section never mentions nginx/').toMatch(/nginx\//)
})

test('every file under nginx/ is named where the runbook says how to install it', () => {
  const files = nginxFiles()
  expect(files.length, 'nginx/ is empty — has it moved?').toBeGreaterThan(0)
  const install = section(fs.readFileSync(DEPLOY, 'utf8'), /nginx/)
  for (const file of files) {
    expect(install, `${file} exists in the repo but the nginx section never names it`).toContain(file)
  }
})
