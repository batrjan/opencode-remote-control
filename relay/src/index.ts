import { shutdown, startServer } from './server.js'
import { config } from './config.js'
import { noteSwallowed } from './faults.js'

/**
 * Runtime entrypoint (Docker CMD, `npm start`). server.ts only exports
 * factories so tests can inject their own Store; this module wires the
 * process-level server.
 */
const server = await startServer()
console.log(`[relay] listening on :${config.port}`)

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    // Persists first, then ends the viewers' streams rather than cutting them
    // (see shutdown() for why that order matters to the web UI).
    void shutdown(server).then(() => process.exit(0))
    // Hard deadline: never let a stuck connection block the redeploy.
    setTimeout(() => process.exit(0), 3000).unref()
  })
}

/**
 * Print what went wrong without trusting it to be printable: `throw
 * Object.create(null)` makes String() itself throw, and a handler that throws
 * is a crash of its own — the one thing these handlers must never be.
 */
function describe(err: unknown): string {
  try {
    if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`
    return String(err)
  } catch {
    return '<unprintable value>'
  }
}

/**
 * Whether the process is still worth keeping alive after an error escaped.
 *
 * Only while it is actually serving: an error raised on the way out means the
 * shutdown itself is failing, and one raised with no listening socket left
 * means this process answers nobody. Staying up in either state hides a state
 * that only a restart fixes — a container that never exits on SIGTERM, or one
 * docker still calls healthy while every share is dead.
 */
const survivable = () => !shuttingDown && server.listening

/**
 * Last resort for everything that escapes its own call stack.
 *
 * ONE process serves EVERY tenant's share here, and Node's default for an
 * uncaught throw is to end it. Four bytes on one bridge socket used to buy
 * exactly that (a `null` frame, see BridgeClient.onMessage): every other live
 * share died with the request that threw. The guards on that socket are the
 * real fix; this is the layer that keeps the NEXT such bug costing one request
 * instead of every tenant. What threw is logged in full, because the default
 * handler that printed it is what this replaces.
 *
 * Registered after the server is listening, deliberately: a start that fails
 * must still kill the process rather than leave one up that serves nobody.
 *
 * Counted first, before anything that could fail: swallowing an error leaves
 * the container healthy and the only trace in a log that rotates, so /health
 * carries the count outward (see faults()). The count must not depend on the
 * error having been printable.
 */
process.on('uncaughtException', (err, origin) => {
  noteSwallowed()
  console.error(`[relay] uncaught exception (${origin}): ${describe(err)}`)
  if (!survivable()) process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  noteSwallowed()
  console.error(`[relay] unhandled rejection: ${describe(reason)}`)
  if (!survivable()) process.exit(1)
})
