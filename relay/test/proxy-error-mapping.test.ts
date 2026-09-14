import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import request from 'supertest'
import { WebSocket } from 'ws'
import { startServer } from '../src/server'
import { config } from '../src/config'

/**
 * A viewer's error has to name the actual failure.
 *
 * Several filtered routes answered every failure with 502 "bridge not
 * connected" — including a bridge that was connected and merely slow. On a
 * congested owner uplink that sent diagnosis the wrong way: the message said
 * the link was down, the relay's own log said it was up. A timeout is a 504
 * "proxy timeout" on every route, the same as on the generic proxy.
 */

const API_KEY = 'test-relay-key'
process.env.RELAY_API_KEY = API_KEY

let relay: Server
let relayUrl: string
const savedTimeout = config.proxyTimeoutMs

beforeEach(async () => {
  ;(config as { proxyTimeoutMs: number }).proxyTimeoutMs = 300
  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
})

afterEach(async () => {
  ;(config as { proxyTimeoutMs: number }).proxyTimeoutMs = savedTimeout
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
})

async function share(session_id: string) {
  const created = await request(relay)
    .post('/api/sessions')
    .set('x-api-key', API_KEY)
    .send({ session_id, directory: '/path', title: 'errors' })
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id })
  return { bridgeToken: created.body.bridge_token as string, viewerToken: activated.body.viewer_token as string }
}

const ROUTES = ['/project', '/session', '/permission', '/question', '/session/status', '/session/ses_errors/message']

test('a connected bridge that does not answer in time is a 504 on every route', async () => {
  const { bridgeToken, viewerToken } = await share('ses_errors')
  // Connected, never answers.
  const ws = new WebSocket(`${relayUrl.replace(/^http/, 'ws')}/bridge?session_id=ses_errors`, {
    headers: { 'x-bridge-token': bridgeToken },
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  try {
    for (const route of ROUTES) {
      const res = await request(relay).get(route).set('x-viewer-token', viewerToken)
      expect({ route, status: res.status, body: res.body }).toEqual({ route, status: 504, body: { error: 'proxy timeout' } })
    }
  } finally {
    ws.terminate()
  }
}, 20_000)

/**
 * The question dock's answer and dismiss time out like any other request.
 *
 * Every path under /question used to be taken for a long-poll and given two
 * minutes instead of the proxy timeout. None of them is one: opencode answers
 * the pending list at once, and a reply or reject only settles a question that
 * is already waiting. So on a congested owner uplink a viewer who pressed a
 * question's button watched it spin for 120 s before the error, where the same
 * click on a permission prompt (POST /session/:id/permissions/:id) gave up
 * after the proxy timeout.
 */
test('a connected bridge that does not answer a question reply in time is a 504 after the proxy timeout', async () => {
  const { bridgeToken, viewerToken } = await share('ses_questions')
  // Connected, never answers.
  const ws = new WebSocket(`${relayUrl.replace(/^http/, 'ws')}/bridge?session_id=ses_questions`, {
    headers: { 'x-bridge-token': bridgeToken },
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  try {
    for (const route of ['/question/que_1/reply', '/question/que_1/reject', '/api/question/que_1/reply']) {
      const answered = request(relay)
        .post(route)
        .set('x-viewer-token', viewerToken)
        .send({ answers: [['yes']] })
        .then(
          (res) => ({ status: res.status, body: res.body as unknown }),
          (err: unknown) => ({ error: String(err) }),
        )
      // Ten times the proxy timeout: well past it, far short of two minutes.
      const deadline = new Promise((resolve) => setTimeout(() => resolve('still waiting after 3 s'), 3_000))
      expect({ route, outcome: await Promise.race([answered, deadline]) }).toEqual({
        route,
        outcome: { status: 504, body: { error: 'proxy timeout' } },
      })
    }
  } finally {
    ws.terminate()
  }
}, 20_000)

test('no bridge at all is a 502 "bridge not connected" on every route', async () => {
  const { viewerToken } = await share('ses_nobridge')
  for (const route of ROUTES.map((r) => r.replace('ses_errors', 'ses_nobridge'))) {
    const res = await request(relay).get(route).set('x-viewer-token', viewerToken)
    expect({ route, status: res.status, body: res.body }).toEqual({ route, status: 502, body: { error: 'bridge not connected' } })
  }
})
