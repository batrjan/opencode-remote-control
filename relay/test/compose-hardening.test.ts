import { expect, test } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * What the production container is allowed to do beyond running the relay.
 *
 * `docker inspect` on the running container showed user=node, no privileged
 * flag and the port published on 127.0.0.1 only — but a writable root
 * filesystem, the default capability set, no no-new-privileges and no pids
 * limit. None of that is a way in by itself; all of it is what a foothold
 * inside the process gets for free, and the relay's job is to run a viewer's
 * commands on someone else's behalf. Container logs had no rotation either, so
 * one `[activate]` line per guess filled the host disk at the attacker's pace.
 *
 * Docker is not installed here, so this reads the compose file. Values that
 * are prose (why there is no mem_limit) live in DEPLOY.md.
 */

const COMPOSE = fileURLToPath(new URL('../docker-compose.yml', import.meta.url))

/** The `relay:` service block — up to the next key at its own indentation. */
function relayService(): string {
  const text = fs.readFileSync(COMPOSE, 'utf8')
  const start = text.search(/^ {2}relay:$/m)
  expect(start, 'no relay service in docker-compose.yml').toBeGreaterThan(-1)
  const rest = text.slice(start).split('\n').slice(1)
  const body: string[] = []
  for (const line of rest) {
    if (line.trim() !== '' && !/^ {3}/.test(line)) break
    body.push(line)
  }
  return body.join('\n')
}

test('the relay container runs with a read-only root and no spare privileges', () => {
  const relay = relayService()
  expect(relay, 'writable root filesystem').toMatch(/^\s*read_only:\s*true\s*$/m)
  // read_only without a writable temp dir is how a container that works in
  // review dies in production, so the tmpfs is part of the same assertion.
  expect(relay, 'read_only with no tmpfs for /tmp').toMatch(/^\s*tmpfs:/m)
  expect(relay).toMatch(/^\s*-\s*\/tmp\b/m)
  // The state file is the one thing that must survive a restart; a read-only
  // root must not have taken its volume away.
  expect(relay).toMatch(/^\s*-\s*relay-state:\/data\s*$/m)

  expect(relay, 'the default capability set is still granted').toMatch(/^\s*cap_drop:\s*$/m)
  expect(relay).toMatch(/^\s*-\s*ALL\s*$/m)
  expect(relay, 'setuid binaries can still raise privileges').toMatch(/no-new-privileges:\s*true/)
  expect(relay, 'no pids_limit: a fork bomb in the container is a fork bomb on the host').toMatch(
    /^\s*pids_limit:\s*\d+\s*$/m,
  )
})

test('container logs are rotated', () => {
  const relay = relayService()
  expect(relay, 'no logging driver options: the log grows until the disk is full').toMatch(
    /^\s*logging:\s*$/m,
  )
  expect(relay).toMatch(/max-size:/)
})

test('the /tmp tmpfs is bounded, and DEPLOY.md quotes the bound it is given', () => {
  // A tmpfs entry with no size= takes the kernel default — half the host's RAM
  // (32 GiB on the relay host) — charged to the HOST, and the container has no
  // mem_limit by design. Under read_only it is also the only writable path
  // outside the state volume, so "there is a tmpfs" was never the whole check.
  const entry = relayService().match(/^\s*-\s*(\/tmp\S*)\s*$/m)
  expect(entry, 'no /tmp tmpfs entry at all').not.toBeNull()
  const size = entry![1].match(/[:,]size=(\d+)([kmg]?)/i)
  expect(size, `tmpfs ${entry![1]} has no size=: the kernel default is half of host RAM`).not.toBeNull()

  const deploy = fs.readFileSync(fileURLToPath(new URL('../../DEPLOY.md', import.meta.url)), 'utf8')
  const row = deploy.split('\n').find((line) => line.startsWith('| `read_only: true`'))
  expect(row, 'the container-hardening row for read_only/tmpfs').toBeDefined()
  expect(row, 'DEPLOY.md does not quote the size the compose file sets').toContain(`size=${size![1]}${size![2]}`)
})
