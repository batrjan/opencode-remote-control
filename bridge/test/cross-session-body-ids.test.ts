import { expect, test } from 'vitest'
import type { OpencodeClient } from '../src/opencode'
import { RelayWSClient } from '../src/relay'

/**
 * A write names its target twice: in the path, and again in the body.
 *
 * opencode acts on the body. `POST /session/<ours>/message` with the
 * `messageID` or a `parts[].id` of ANOTHER session appends to — or overwrites
 * a part of — that other session, in another project of the owner's, and
 * answers 200 (measured on opencode 1.18.31; its read routes check ownership,
 * its writes do not). The bridge's guards only ever looked at the path, so the
 * binding they enforce stopped at the first of the two names.
 *
 * The ids are minted by the viewer's browser, so nothing about their shape or
 * their timestamp can say whose they are. What CAN: the bridge is the one
 * forwarding the event stream, so every id the relay could have learned about
 * another session, the bridge saw first — and can refuse to write to.
 */
const SES = 'ses_bodyGuard01'
const OTHER = 'ses_ownerOtherWork'
const FOREIGN_MESSAGE = 'msg_0b0e40df3001XcImwJuIYI3YNB'
const FOREIGN_PART = 'prt_0b0e40df80011wmFM8Fst717w6'

/** One SSE event, as opencode sends it (see its /event stream). */
function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      // Left open: the real stream ends only when opencode goes away.
    },
  })
}

async function connected(events: string) {
  const calls: Array<{ path: string; body: unknown }> = []
  const opencode = {
    request: async (method: string, path: string, body: unknown) => {
      calls.push({ path: `${method} ${path}`, body })
      return { status: 200, contentType: 'application/json', body: '{}' }
    },
    getEvent: async () => streamOf(events),
  }
  const client = new RelayWSClient('http://relay.invalid', opencode as unknown as OpencodeClient)
  const sent: Array<{ request_id: string; status: number; body: string }> = []
  ;(client as unknown as { ws: unknown }).ws = {
    readyState: 1,
    // Nothing queued: event forwarding waits for room on the real socket.
    bufferedAmount: 0,
    send: (raw: string) => sent.push(JSON.parse(raw)),
    close: () => {},
  }
  ;(client as unknown as { boundSessionId: string }).boundSessionId = SES
  ;(client as unknown as { sessionDirectory: string }).sessionDirectory = '/proj'
  await client.startEventForwarding()
  // The stream is read asynchronously; let it hand the events over.
  for (let i = 0; i < 50 && sent.filter((f) => (f as { type?: string }).type === 'event').length < 2; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  const post = (request_id: string, body: unknown) =>
    (client as unknown as { onMessage(raw: unknown): Promise<void> }).onMessage(
      JSON.stringify({ type: 'proxy', request_id, method: 'POST', path: `/session/${SES}/message?directory=%2Fproj`, body }),
    )
  return { calls, sent, post, close: () => client.close() }
}

/** What the owner's OTHER session, in the same project, puts on the stream. */
const FOREIGN_EVENTS =
  sse({
    id: 'evt_1',
    type: 'message.updated',
    properties: { sessionID: OTHER, info: { id: FOREIGN_MESSAGE, role: 'user', sessionID: OTHER } },
  }) +
  sse({
    id: 'evt_2',
    type: 'message.part.updated',
    properties: {
      sessionID: OTHER,
      part: { id: FOREIGN_PART, messageID: FOREIGN_MESSAGE, sessionID: OTHER, type: 'text', text: 'their work' },
    },
  })

test("a body naming another session's message or part never reaches opencode", async () => {
  const c = await connected(FOREIGN_EVENTS)
  try {
    await c.post('r1', { messageID: FOREIGN_MESSAGE, parts: [{ type: 'text', text: 'injected' }] })
    await c.post('r2', { parts: [{ id: FOREIGN_PART, type: 'text', text: 'overwritten' }] })
    expect(c.calls).toEqual([])
    expect(c.sent.filter((f) => f.request_id !== undefined).map((m) => [m.status, JSON.parse(m.body).error])).toEqual([
      [403, 'request body names another session'],
      [403, 'request body names another session'],
    ])

    // The viewer's own prompt — ids it minted for a message that does not
    // exist yet — is untouched, which is every real prompt.
    await c.post('r3', { messageID: 'msg_0b0e6a3b7001Tmb0oNbYI7pNUe', parts: [{ id: 'prt_0b0e6a3bd001Y3HUnOpipyowgv', type: 'text', text: 'hello' }] })
    expect(c.calls).toHaveLength(1)
    expect(c.sent.find((m) => m.request_id === 'r3')?.status).toBe(200)
  } finally {
    c.close()
  }
})

test('an id that is not an id is refused before opencode sees it', async () => {
  const c = await connected('')
  try {
    await c.post('r1', { messageID: { toString: 'nope' } })
    await c.post('r2', { parts: [{ id: 'prt_' + 'A'.repeat(500) }] })
    await c.post('r3', { messageID: 'msg_../../etc/passwd' })
    expect(c.calls).toEqual([])
    expect(c.sent.map((m) => m.status).filter((s) => s !== undefined)).toEqual([403, 403, 403])
  } finally {
    c.close()
  }
})
