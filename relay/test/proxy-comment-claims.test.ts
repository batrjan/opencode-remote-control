import { expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What the proxy adapter's comments claim, against what the proxy adapter does.
 *
 * Two of them outlived their code. The session binding stopped rewriting a
 * foreign `:id` to the viewer's own session and started REFUSING it with the
 * marked 401 — the whole point of that change is that a tab left on another
 * share is sent back to its own page instead of acting in a stranger's session
 * — while two comments went on describing the rewrite as the mechanism. And
 * `X-OC-Relay-Share` is verified here but sent by nothing in the tree, which
 * its comment described in the present tense, so the next reader would take a
 * defence that is half-built for one that is running.
 *
 * Cheap guards, in the style of the coherence checks in
 * payload-cap-coherence.test.ts: they follow the code, so the day the shell
 * starts sending the header, or a rewrite comes back, the claim has to be
 * rewritten with it.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const ADAPTER = path.join(SRC, 'proxy/adapter.ts')
const adapter = fs.readFileSync(ADAPTER, 'utf8')

/** Every .ts under relay/src, so a claim about "the tree" is checked against it. */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    return entry.isFile() && full.endsWith('.ts') ? [full] : []
  })
}

/** The doc comment immediately above `declaration`. */
function docAbove(source: string, declaration: string): string {
  const at = source.indexOf(declaration)
  expect(at, `${declaration} in the adapter`).toBeGreaterThan(-1)
  const opened = source.lastIndexOf('/**', at)
  const closed = source.lastIndexOf('*/', at)
  expect(opened, `a doc comment above ${declaration}`).toBeGreaterThan(-1)
  expect(closed).toBeGreaterThan(opened)
  return source.slice(opened, closed)
}

test('no comment describes the foreign-id rewrite the proxy no longer does', () => {
  // The behaviour they would be describing: a foreign id is refused, marked, and
  // told apart from an unfinished walk.
  expect(adapter).toContain("VIEWER_AUTH_INVALID = 'viewer-invalid'")
  expect(adapter).toContain('function refuseForeignId')

  for (const claim of [
    /Every ':id' is normally rewritten/,
    /The URL :id is ALWAYS replaced/,
    /still collapses to the bound session/,
  ]) {
    expect(adapter, `a comment still claims: ${claim.source}`).not.toMatch(claim)
  }
})

test('the share header’s comment says whether anything actually sends it', () => {
  const senders = sources(SRC)
    .filter((file) => file !== ADAPTER)
    // Either spelling counts as a sender: the literal header name, or the
    // exported constant (server.ts imports it rather than repeating the string,
    // which is how a real sender went unnoticed by this test once).
    .filter((file) => /oc-relay-share|VIEWER_SHARE_HEADER/i.test(fs.readFileSync(file, 'utf8')))
  const doc = docAbove(adapter, 'export const VIEWER_SHARE_HEADER')
  console.log(`share header senders: ${JSON.stringify(senders.map((f) => path.relative(SRC, f)))}`)

  if (senders.length === 0) {
    // Nothing sends it, so the comment may not say that something does — it is
    // a contract for the shell that will, and a reader has to be able to tell
    // the two apart.
    expect(doc, 'the comment claims a sender the tree does not have').not.toMatch(/Sent BY a UI shell/)
    expect(doc, 'the comment does not say that nothing sends it yet').toMatch(/nothing (?:in the tree )?sends it/i)
  } else {
    expect(doc, 'the comment still says nothing sends it').not.toMatch(/nothing (?:in the tree )?sends it/i)
  }
})

test('the inbound watchdog does not call a count of wire bytes a finished body', () => {
  // `read - startedAt >= claim` compares req.socket.bytesRead — WIRE bytes,
  // chunk framing and compressed bytes included — with a claim that is the
  // whole body limit for anything chunked or encoded. The comment called that
  // branch "a body that has fully arrived": for an identity body it is, but a
  // chunked one reaches it with 26 MiB of wire and ~4.3 MiB of body, still
  // arriving, and the rate rule silently stops applying to the rest. No
  // strengthening for an attacker (26 MiB of uplink against the ~650 KB that
  // dripping costs for the same hold), so what is wrong is the invariant the
  // next reader would build on.
  const from = adapter.indexOf('No-progress watchdog for the body itself')
  expect(from, 'the inbound watchdog and its comment').toBeGreaterThan(-1)
  const watchdog = adapter.slice(from, adapter.indexOf('stopStallWatch()', from))
  expect(watchdog, 'the branch this claim is about is gone').toContain('read - startedAt >= claim')
  expect(watchdog, 'the comment still calls a wire-byte count a finished body').not.toMatch(/fully arrived/)
  // And it has to say which bodies make the two differ, so the difference stays
  // visible instead of being rediscovered.
  expect(watchdog, 'the comment never says bytesRead counts the wire').toMatch(/WIRE bytes/)
  expect(watchdog, 'the comment never says which bodies that is wrong for').toMatch(/chunked/)
})
