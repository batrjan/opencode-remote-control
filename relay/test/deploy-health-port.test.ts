import { afterAll, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The port the deploy's health probe polls, run as the deploy runs it.
 *
 * The probe reads PORT out of the host's `.env` because hard-coding 8080 made a
 * relay moved off it fail its own deploy. It read the value VERBATIM, though,
 * and `.env` is docker compose's format, not a shell's: `PORT="9090"` is a
 * legal spelling there (compose hands the container `9090` either way, and the
 * container is healthy), but the quotes went straight into the probe's URL —
 * `curl: (3) URL rejected: Port number was not a decimal number`, twenty times,
 * then a rollback, then `production is DOWN` printed over a container that was
 * answering perfectly. A `.env` edited on Windows (CRLF) does the same. The
 * knob that was made safe to turn was still unsafe to quote.
 *
 * So the probe takes the DIGITS out of the line. This runs the workflow's own
 * two lines — lifted out of deploy.yml, with only the /opt path pointed at a
 * temporary file — against every spelling an operator might leave behind.
 */

const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/deploy.yml', import.meta.url))
const HOST_ENV = '/opt/opencode-remote-control/.env'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-health-port-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** The HEALTH_PORT lines of wait_healthy(), verbatim. */
function healthPortLines(): string[] {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8')
  const fn = /wait_healthy\(\)\s*\{([\s\S]*?)\n\s*\}\n/.exec(workflow)
  expect(fn, 'a wait_healthy() function in deploy.yml').not.toBeNull()
  const lines = fn![1].split('\n').filter((line) => /(^|\s)HEALTH_PORT=/.test(line))
  expect(lines.length, 'the two lines that decide the port').toBe(2)
  expect(fn![1], 'the probe no longer polls the port those lines chose').toContain('127.0.0.1:$HEALTH_PORT')
  return lines
}

/** What wait_healthy() would poll, given this `.env` content. */
function portFrom(envFile: string): string {
  const file = path.join(tmp, `${Math.random().toString(36).slice(2)}.env`)
  fs.writeFileSync(file, envFile)
  const script = `${healthPortLines()
    .map((line) => line.trim().split(HOST_ENV).join(file))
    .join('\n')}\nprintf '%s' "$HEALTH_PORT"\n`
  return execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' })
}

test("the health probe reads a port from every spelling compose accepts in .env", () => {
  // Today's production file, and the five other writings of the same knob that
  // docker compose reads identically.
  for (const line of ['PORT=18733', 'PORT="18733"', "PORT='18733'", 'PORT=18733 ', 'PORT=18733 # moved off 8080', 'PORT=18733\r']) {
    expect(portFrom(`SOME_OTHER=1\n${line}\n`), `${JSON.stringify(line)} is a port the probe can poll`).toBe('18733')
  }
})

test('the health probe falls back to 8080 when the file names no port', () => {
  expect(portFrom('OTHER=1\n'), 'no PORT line at all').toBe('8080')
  expect(portFrom('PORT=\n'), 'an empty PORT').toBe('8080')
  expect(portFrom('PORT="" # unset again\n'), 'a PORT quoted empty').toBe('8080')
  // Not this relay's knob, and it must not be mistaken for it.
  expect(portFrom('PORTS=9999\n'), 'a variable that merely starts with PORT').toBe('8080')
})

test('the last PORT line wins, as docker compose reads it', () => {
  expect(portFrom('PORT=8080\nPORT=9090\n')).toBe('9090')
})
