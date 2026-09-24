import { expect, test } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Whether `relay/.env.example` still describes the relay it configures.
 *
 * README points at this file as where the relay's defaults are ("Env vars
 * (relay defaults also in `relay/.env.example`)"), and an operator sizing a
 * relay copies it to the host. It had drifted: fifteen of the variables
 * config.ts reads were absent from it, including all three inbound proxy
 * bounds added by the DoS work, so the file quietly said "these knobs do not
 * exist". A default written in it and then changed in config.ts is the other
 * half of the same problem — the operator would be setting the old number
 * believing it to be the current one.
 *
 * Both checks read config.ts, so the day a knob is added, renamed or
 * re-defaulted, this file has to follow.
 */

const CONFIG_SRC = fileURLToPath(new URL('../src/config.ts', import.meta.url))
const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))
const ENV_EXAMPLE = fileURLToPath(new URL('../.env.example', import.meta.url))

/** Every .ts under relay/src. */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = `${dir}/${entry.name}`
    if (entry.isDirectory()) return sources(full)
    return entry.isFile() && full.endsWith('.ts') ? [full] : []
  })
}

/** Env var names the relay reads anywhere in src/. */
function namesRead(): Set<string> {
  const names = new Set<string>()
  for (const file of sources(SRC_DIR)) {
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(/env(?:Int|Bool)\(\s*'([A-Z0-9_]+)'/g)) names.add(m[1])
    for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1])
    // persist.ts takes the environment as a parameter: `env.RELAY_STATE_KEY`.
    for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]{3,})/g)) names.add(m[1])
  }
  return names
}

/** `# NAME=value` lines in .env.example, which is how it writes its defaults. */
function documented(): Map<string, string | undefined> {
  const entries = new Map<string, string | undefined>()
  for (const line of fs.readFileSync(ENV_EXAMPLE, 'utf8').split('\n')) {
    const m = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=(.*)$/)
    if (m) entries.set(m[1], m[2].trim() === '' ? undefined : m[2].trim())
  }
  return entries
}

test('every env var the relay reads is named in .env.example', () => {
  const read = namesRead()
  expect(read.size, 'no env vars found — has config.ts been rewritten?').toBeGreaterThan(15)
  const named = new Set([
    ...documented().keys(),
    // Mentioned in prose rather than as a setting: it is accepted and ignored.
    ...[...fs.readFileSync(ENV_EXAMPLE, 'utf8').matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)].map((m) => m[1]),
  ])
  expect([...read].filter((name) => !named.has(name)).sort()).toEqual([])
})

/** A default expression of literals and `*`, e.g. `25 * 1024 * 1024`. */
function literal(expression: string): number | undefined {
  const clean = expression.replace(/_/g, '').trim()
  if (!/^\d+(\s*\*\s*\d+)*$/.test(clean)) return undefined
  return clean.split('*').reduce((total, part) => total * Number(part.trim()), 1)
}

test('every default .env.example writes is the default config.ts applies', () => {
  const src = fs.readFileSync(CONFIG_SRC, 'utf8')
  const defaults = new Map<string, number>()
  for (const m of src.matchAll(/envInt\(\s*'([A-Z0-9_]+)'\s*,\s*([^)]+)\)/g)) {
    const value = literal(m[2])
    if (value !== undefined) defaults.set(m[1], value)
  }
  expect(defaults.size, 'no numeric defaults parsed out of config.ts').toBeGreaterThan(10)

  const wrong: string[] = []
  for (const [name, written] of documented()) {
    const expected = defaults.get(name)
    if (expected === undefined || written === undefined) continue
    if (Number(written) !== expected) wrong.push(`${name}=${written}, config.ts defaults to ${expected}`)
  }
  expect(wrong, 'a default in .env.example is not the one the relay applies').toEqual([])
})
