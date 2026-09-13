import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { shutdown, startServer } from '../src/server'

/**
 * Stopping the relay must END the viewers' live streams, not cut them.
 *
 * The web UI's SSE reader (upstream, not ours to patch) waits 3 s, 6 s, 12 s,
 * 24 s and then 30 s between attempts, and it counts attempts for as long as
 * that reader lives: a successful reconnect does not reset the count. Only a
 * stream that ends normally retires the reader, and the UI then opens a fresh
 * one 250 ms later with the count back at zero. A connection closed without
 * the final chunk is an error to it instead ("terminated" in Node, "network
 * error" in Chromium).
 *
 * The relay's signal handler did exactly that to every open stream: it called
 * closeAllConnections(). So each redeploy added an attempt to every open tab,
 * plus one for each refused retry while the relay was down. Measured with the
 * UI's own reader against five restarts that each took milliseconds: the tab
 * waited 3, 6, 12, 24 and 30 s. After four or so, a tab that had been open all
 * day went blind for 30 s on every restart, however quick, before it resynced.
 *
 * shutdown() is what the signal handler runs.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

let relay: Server
let relayUrl: string
let viewerToken: string

beforeEach(async () => {
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
  const created = await request(relay)
    .post('/api/sessions')
    .send({ session_id: 'ses_shutdown', directory: '/work', title: 't' })
  expect(created.status).toBe(201)
  const activated = await request(relay)
    .post('/api/activate')
    .send({ code: created.body.access_code, session_id: 'ses_shutdown' })
  expect(activated.status).toBe(200)
  viewerToken = activated.body.viewer_token
})

afterEach(async () => {
  if (!relay.listening) return
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
})

/** Open a viewer stream and read it up to its `server.connected` handshake. */
async function openStream(path: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await fetch(`${relayUrl}${path}`, { headers: { 'x-viewer-token': viewerToken } })
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  while (!seen.includes('server.connected')) {
    const { value, done } = await reader.read()
    if (done) throw new Error('stream ended before its handshake')
    seen += decoder.decode(value, { stream: true })
  }
  return reader
}

/** How the stream finished, as the UI's reader tells the two apart. */
async function outcome(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  try {
    for (;;) {
      const { done } = await reader.read()
      if (done) return 'ended'
    }
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause
    return `failed: ${(err as Error).message}${cause?.code ? ` (${cause.code})` : ''}`
  }
}

test('stopping the relay ends open viewer streams instead of cutting them', async () => {
  const global = await openStream('/global/event')
  const bare = await openStream('/event')

  const started = Date.now()
  const stopped = shutdown(relay)

  expect(await outcome(global)).toBe('ended')
  expect(await outcome(bare)).toBe('ended')

  // The UI reconnects 250 ms after a stream ends. That must not reach this
  // process, which is about to drop every connection it still holds: a stream
  // opened here would be cut after all. The relay has to stop taking
  // connections BEFORE it ends the streams, so ask the moment they have ended.
  const reconnect = await fetch(`${relayUrl}/global/event`, { headers: { 'x-viewer-token': viewerToken } }).then(
    (res) => `HTTP ${res.status}`,
    (err: { cause?: { code?: string } }) => err.cause?.code,
  )
  expect(reconnect).toBe('ECONNREFUSED')

  // And the shutdown finishes well within the signal handler's 3 s deadline.
  await stopped
  expect(Date.now() - started).toBeLessThan(2000)
}, 10_000)
