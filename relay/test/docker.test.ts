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
// "Successfully built" in stdout, but which builder runs this is not ours to
// assume: BuildKit does not print that line, and Docker 29 is not BuildKit-only
// — the relay host runs 29.1.3 with no buildx plugin, so `docker build` there
// falls back to the legacy builder (its own `docker build --help` prints the
// legacy-builder deprecation banner, and the layers that host adds carry
// `#(nop)`, not `buildkit.dockerfile.v0`). A zero exit code plus an inspectable
// image is the success signal under either builder. execFileP rejects on
// non-zero exit, carrying the build log in error.stdout/stderr for debugging.
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
