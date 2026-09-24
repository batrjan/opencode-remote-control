/**
 * Error text for the owner.
 *
 * Node's fetch throws the same TypeError('fetch failed') for every
 * connection-level failure — refused, a mistyped host, a reset, a certificate
 * it does not trust — and keeps the actual reason on `err.cause`. The CLI
 * printed only the top-level message, and no call said which server it was
 * for, so a mistyped relay URL, a corporate CA and a dead local opencode all
 * reached the owner (and the TUI toast) as "bridge start failed: fetch failed".
 */

/** How many `cause` links are followed; a real chain is two or three deep. */
const MAX_CAUSE_DEPTH = 4

/**
 * C0 controls (newlines and tabs included), DEL and C1.
 *
 * Everything in here does something to a terminal rather than appearing in it:
 * ESC opens a control sequence that can repaint the screen, rename the window
 * or, on some terminals, put text into the user's input; BEL closes an OSC
 * string; CR redraws the line; LF forges a line the bridge never printed. C1
 * is the 8-bit spelling of the same escapes.
 */
const TERMINAL_CONTROLS = /[\x00-\x1f\x7f-\x9f]/g

/**
 * Text from the relay, safe to put in front of the owner.
 *
 * A share's status, title and directory come back over the wire, are printed
 * to a terminal (`bridge status` runs inside the TUI) and are appended to
 * bridge.log, which owners read with `cat`. Raw control bytes there let a
 * relay repaint the owner's screen or hide lines from it, so they are dropped
 * — visibly, as the rest of the payload stays — and the length is bounded so
 * one field cannot scroll the answer away.
 */
export function safeForTerminal(text: string, maxChars = 200): string {
  const stripped = text.replace(TERMINAL_CONTROLS, '')
  return stripped.length > maxChars ? `${stripped.slice(0, maxChars)}…` : stripped
}

/**
 * An error's message followed by each cause it does not already quote, on ONE
 * line: `fetch failed (connect ECONNREFUSED 127.0.0.1:4096)`.
 *
 * One line because the plugin keeps only the first line of the bridge's output
 * that matches its failure pattern (plugin/bridge-runner.js parseBridgeLog) —
 * a cause on a line of its own would never reach the toast. Never the stack.
 * A URL with credentials in it loses them: the text lands in bridge.log and in
 * the toast.
 */
export function describeError(err: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = err
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current != null && !seen.has(current); depth++) {
    seen.add(current)
    const text = withoutUserinfo(
      depth === 0 && !(current instanceof Error) ? oneLine(String(current)) : errorText(current),
    )
    // A cause a wrapper already quotes (see fetchFrom) is not repeated.
    if (text && !parts.some((part) => part.includes(text))) parts.push(text)
    current = current instanceof Error ? current.cause : undefined
  }
  const [head = withoutUserinfo(oneLine(String(err))), ...causes] = parts
  return causes.length === 0 ? head : `${head} (${causes.join('; ')})`
}

/**
 * fetch(), except that a request that could not be made at all says which
 * server it was for: `relay https://relay.example unreachable: fetch failed
 * (getaddrinfo ENOTFOUND relay.example)`. `server` names it for the owner.
 *
 * Only the origin is quoted, never the full URL: a relay URL pasted with
 * credentials in it must not end up in bridge.log or a toast. The original
 * error stays on `cause`. Timeouts and aborts pass through untouched — callers
 * tell those apart by name and word them themselves — and so does anything
 * thrown for a URL that has no origin to name (it quotes the bad value).
 */
export async function fetchFrom(server: string, url: string, init?: Parameters<typeof fetch>[1]): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw err
    const origin = originOf(url)
    if (origin === undefined) throw err
    throw new Error(`${server} ${origin} unreachable: ${describeError(err)}`, { cause: err })
  }
}

/** `url`'s origin, or undefined when it is no URL or has none to name (an opaque 'null' origin). Never throws. */
export function originOf(url: string): string | undefined {
  try {
    const { origin } = new URL(url)
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

/** One link of a chain: `code: message`, or just the message when it already names the code. */
function errorText(err: unknown): string {
  if (typeof err === 'string') return oneLine(err)
  if (!(err instanceof Error)) return ''
  let message = err.message
  // A name with several addresses (localhost: ::1 and 127.0.0.1) fails as an
  // AggregateError with an empty message; each address's error has the text.
  if (!message && err instanceof AggregateError) {
    message = err.errors
      .map((inner: unknown) => (inner instanceof Error ? inner.message : String(inner)))
      .filter(Boolean)
      .join(', ')
  }
  message = oneLine(message)
  const code = (err as { code?: unknown }).code
  if (typeof code !== 'string' || message.includes(code)) return message
  return message ? `${code}: ${message}` : code
}

/**
 * One line, and only characters that print. Error text quotes what a server
 * said — including a relay's own `error` string — so the escapes go here too,
 * at the single place every message passes through.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').replace(TERMINAL_CONTROLS, '').trim()
}

/** `scheme://user:password@host` → `scheme://host`, wherever a message quotes a URL. */
function withoutUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, '$1')
}
