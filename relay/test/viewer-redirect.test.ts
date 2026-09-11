import { afterAll, beforeAll, expect, test } from 'vitest'
import type { Server } from 'node:http'
import request from 'supertest'
import { startServer } from '../src/server'

/**
 * The redirect a viewer actually follows after entering their code.
 *
 * /<session_id> hands the browser the official UI's canonical session URL,
 * whose first segment is the project directory encoded the way the UI itself
 * encodes it. Get that encoding wrong and the share still "works" by every
 * server-side measure — 200s everywhere, a valid cookie, a connected bridge —
 * while the viewer stares at an empty project list and an invalid-directory
 * toast. Found exactly that way: through a browser, not through the API.
 *
 * The UI's own pair, read out of its shipped bundle:
 *   encode: btoa(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')
 *   decode: atob(seg.replace(/-/g,'+').replace(/_/g,'/'))
 * i.e. base64url, unpadded. These tests hold the relay to it.
 */

let relay: Server

beforeAll(async () => {
  process.env.ACTIVATE_FAIL_DELAY_MS = '0'
  relay = await startServer(0)
})

afterAll(async () => {
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
})

/** The viewer UI's decoder, transcribed from the shipped bundle. */
function uiDecode(segment: string): string {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

async function shareAndJoin(id: string, directory: string) {
  const created = await request(relay).post('/api/sessions').send({ session_id: id, directory, title: 't' })
  expect(created.status).toBe(201)
  const activated = await request(relay)
    .post('/api/activate')
    .send({ code: created.body.access_code, session_id: id })
  expect(activated.status).toBe(200)
  const redirect = await request(relay)
    .get(`/${id}`)
    .set('Cookie', `viewer_token=${activated.body.viewer_token}`)
  expect(redirect.status).toBe(302)
  return { location: redirect.headers.location as string, bridgeToken: created.body.bridge_token as string }
}

/**
 * Three directory lengths, because base64 padding is length mod 3: the old
 * encoding produced '%3D%3D', '%3D' and no padding respectively, so a share
 * broke or worked purely on how long the project path was. All three must
 * round-trip now.
 */
const CASES: Array<[string, string]> = [
  ['ses_pad2', '/private/tmp/rc-e2e'], // 19 chars -> two '=' under plain base64
  ['ses_pad1', '/private/tmp/rc-e2ee'], // 20 chars -> one '='
  ['ses_pad0', '/private/tmp/rc-e2eee'], // 21 chars -> none
  // Bytes whose standard-base64 alphabet hits '+' and '/', the two characters
  // that made the segment either undecodable or a second path segment.
  ['ses_slash', '/tmp/проект~~~?a=b&c'],
]

for (const [id, directory] of CASES) {
  test(`the viewer redirect round-trips ${JSON.stringify(directory)}`, async () => {
    const { location, bridgeToken } = await shareAndJoin(id, directory)
    const segments = location.split('/')
    // /<dir>/session/<id> — exactly three segments after the leading slash.
    expect(segments.length).toBe(4)
    const dirSegment = segments[1]!
    // Nothing that needs escaping, so nothing can be mangled in transit.
    expect(dirSegment).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(dirSegment).not.toContain('%')
    expect(dirSegment).not.toContain('=')
    // And the UI's own decoder gets the directory back.
    expect(uiDecode(dirSegment)).toBe(directory)
    expect(segments[2]).toBe('session')
    expect(segments[3]).toBe(id)

    await request(relay).delete(`/api/sessions/${id}`).set('x-bridge-token', bridgeToken)
  })
}

test('the UI route accepts the segment the redirect produced', async () => {
  const { location, bridgeToken } = await shareAndJoin('ses_route', '/private/tmp/rc-e2e')
  const created = await request(relay).get(location)
  // No viewer cookie on this request: it must bounce to the code-entry page
  // rather than 404, which is what proves the route matched the segment at all.
  expect(created.status).toBe(302)
  expect(created.headers.location).toBe('/ses_route')

  await request(relay).delete('/api/sessions/ses_route').set('x-bridge-token', bridgeToken)
})
