/**
 * Errors the relay survived rather than died of.
 *
 * ONE process serves EVERY tenant's share, so an error that escapes its own
 * call stack is logged and swallowed instead of ending the process (see the
 * handlers in index.ts): the alternative is every live share dying of a bug
 * that cost one request. The cost of that choice is that from outside nothing
 * changes — /health stays healthy, which is exactly what the Docker HEALTHCHECK
 * and the compose probe read, and the only trace is a line in a log that
 * rotates.
 *
 * This is the signal that survives that: a count and when it last happened,
 * reported in /health's body. Deliberately NOT a health verdict — a probe
 * turning red would restart the process, which is the outage those handlers
 * exist to prevent. It is for the operator who reads the body: a relay that
 * quietly swallows a fault per request is one to look at, on a schedule of the
 * operator's choosing.
 */

let swallowed = 0
let lastAt: number | undefined

/** Record one error that escaped and was survived. Never throws. */
export function noteSwallowed(): void {
  swallowed += 1
  lastAt = Date.now()
}

/** What /health reports: a zero count is itself the news that there is none. */
export function faults(): { swallowed: number; last_at?: number } {
  return { swallowed, last_at: lastAt }
}
