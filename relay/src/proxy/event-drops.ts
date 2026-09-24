/**
 * What the event filter dropped for carrying no session id.
 *
 * The viewer's event stream forwards an UNSESSIONED opencode event only if its
 * kind is on the allow-list in adapter.ts (GLOBAL_EVENT_KINDS). That is the
 * safe default — opencode's /event is scoped to the shared project directory
 * and to nothing narrower — but it is also a default that fails QUIETLY: if a
 * kind the viewer's UI turns out to need is missing from the list, the symptom
 * is a panel that never updates, with nothing anywhere to point at it, and
 * whoever debugs that starts from the browser and ends up here days later.
 *
 * So each drop is counted by kind, and the counts ride on /health's operator
 * side next to `faults` (they are not public: they would tell an anonymous
 * caller what the owner's opencode is doing, which is the very thing the
 * filter exists to withhold). The first drop of each kind also logs one line,
 * so a tail of the relay's log names it without anyone having to ask /health.
 *
 * Bounded on purpose. The kinds come from the owner's own opencode over the
 * bridge, so the input is not hostile in the usual sense, but a bridge that
 * invents a kind per event must not grow this map or this log without end:
 * after MAX_KINDS distinct kinds, further unseen ones are counted under
 * OVERFLOW_KEY and logged not at all.
 */

/**
 * Entries this map may ever hold — MAX_KINDS - 1 named kinds plus the overflow
 * bucket, so the cap bounds the whole map and not just its named part.
 */
const MAX_KINDS = 64

/** Where kinds past the cap are counted. Holds the reserved last slot. */
const OVERFLOW_KEY = '(other)'

const dropped = new Map<string, number>()

/**
 * Record one dropped unsessioned event. Never throws: it runs inside the
 * per-event filter, on the path of every viewer's stream.
 */
export function noteDroppedGlobalEvent(kind: string): void {
  const known = dropped.has(kind)
  if (!known && dropped.size >= MAX_KINDS - 1) {
    dropped.set(OVERFLOW_KEY, (dropped.get(OVERFLOW_KEY) ?? 0) + 1)
    return
  }
  dropped.set(kind, (dropped.get(kind) ?? 0) + 1)
  // One line per kind for the life of the process, bounded by MAX_KINDS.
  if (!known) console.log(`[events] dropping unsessioned event kind=${JSON.stringify(kind)} (not in the viewer allow-list)`)
}

/** What /health reports: kind → how many of it a viewer was not shown. */
export function droppedGlobalEvents(): Record<string, number> {
  return Object.fromEntries(dropped)
}

/** Tests only: forget what has been counted so far. */
export function resetDroppedGlobalEvents(): void {
  dropped.clear()
}
