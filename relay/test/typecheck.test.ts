import { expect, test } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * Whether the tests still call the code the way the code is now written.
 *
 * vitest strips types without checking them, and the only typecheck that runs
 * (tsconfig.json, the build and CI) covers src/ alone. So when a signature
 * changes, a call site left behind in a test keeps passing: JavaScript drops an
 * extra argument silently. That is how Store.activate lost its `ip` parameter
 * (the per-address activation limit was removed) while
 * viewer-lifecycle.test.ts went on passing an address to it, which reads as if
 * the address still mattered to the outcome being asserted.
 *
 * This compiles src/ and test/ as one program (tsconfig.test.json) and fails on
 * any diagnostic, printed with file and line.
 */
const CONFIG = fileURLToPath(new URL('../tsconfig.test.json', import.meta.url))

test('the tests type-check against the current source', () => {
  const read = ts.readConfigFile(CONFIG, ts.sys.readFile)
  expect(read.error, 'tsconfig.test.json is readable').toBeUndefined()
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(CONFIG))
  // Guard against a glob that silently matches nothing and checks nothing.
  expect(parsed.fileNames.some((f) => f.endsWith('/test/viewer-lifecycle.test.ts'))).toBe(true)

  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
  const report = ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => path.dirname(CONFIG),
    getNewLine: () => '\n',
  })
  expect(report).toBe('')
}, 60_000)
