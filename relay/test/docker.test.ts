import { expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileP = promisify(execFile)

/** relay/ dir (build context), resolved from this file so any CWD works. */
const RELAY_DIR = fileURLToPath(new URL('..', import.meta.url))

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileP('docker', ['version'])
    return true
  } catch {
    return false
  }
}

const hasDocker = await dockerAvailable()

// Smoke test: the image builds. The plan's original assertion looked for
// "Successfully built" in stdout, but BuildKit (the only builder in Docker
// 29) never prints that line — a zero exit code plus an inspectable image is
// the success signal. execFileP rejects on non-zero exit, carrying the
// build log in error.stdout/stderr for debugging.
test.runIf(hasDocker)(
  'Dockerfile builds',
  async () => {
    await execFileP('docker', ['build', '-t', 'relay-test', RELAY_DIR], {
      maxBuffer: 64 * 1024 * 1024,
    })
    const { stdout } = await execFileP('docker', [
      'image',
      'inspect',
      'relay-test',
      '--format',
      '{{.Id}}',
    ])
    expect(stdout.trim()).not.toBe('')
  },
  600_000,
)
