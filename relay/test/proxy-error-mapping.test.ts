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

const ROUTES = ['/project', '/session', '/permission', '/session/status', '/session/ses_errors/message']

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

test('no bridge at all is a 502 "bridge not connected" on every route', async () => {
  const { viewerToken } = await share('ses_nobridge')
  for (const route of ROUTES.map((r) => r.replace('ses_errors', 'ses_nobridge'))) {
    const res = await request(relay).get(route).set('x-viewer-token', viewerToken)
    expect({ route, status: res.status, body: res.body }).toEqual({ route, status: 502, body: { error: 'bridge not connected' } })
  }
})
