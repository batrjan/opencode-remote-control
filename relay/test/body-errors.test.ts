import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import http from 'node:http'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { BridgeClient } from '../src/ws/bridge'

/**
 * A request body the relay cannot read is answered in JSON, and never logged.
 *
 * Only an over-limit body was mapped (413). Every other failure of a JSON
 * parser — a body that is not JSON, a charset or content encoding it cannot
 * decode, gzip that does not inflate — went to express's final handler, which
 * answered an HTML page and printed the error's full stack: about 950 bytes
 * and 11 lines per request, for anyone, since the public routes parse before
 * any check. (nginx's tight zone on /api/activate is an exact match that
 * /api/activate/x and /API/activate both miss; express routed them to the
 * same parser until the relay came to answer only the exact spelling, see
 * activate-canonical-path.test.ts.) And the SyntaxError's message quotes the
 * raw body around the fault, newlines included, so a caller could write lines
 * of its own choosing into the relay's log. NODE_ENV=production does not stop
 * the logging (express skips it only for 'test'), so the app is put there
 * below: under vitest's NODE_ENV=test this half of the bug is invisible.
 */

let relay: http.Server
let store: Store
let errorLog: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  // Assembled like startServer, so the proxy adapter (and its own parser) is
  // mounted, with the store in hand to join a viewer without a bridge.
  store = new Store()
  relay = http.createServer()
  const bridge = new BridgeClient(relay, store)
  const app = createApp(store, bridge)
  app.set('env', 'production')
  relay.on('request', app)
  relay.on('close', () => bridge.close())
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
})

afterEach(async () => {
  errorLog.mockRestore()
  relay.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
})

/**
 * The final handler logs on a later turn (setImmediate), so wait before
 * checking, or its line lands in the next test. Soft, so a run on the old
 * handler reports both halves: the HTML answer and the stack it logged.
 */
async function nothingLogged() {
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect.soft(errorLog.mock.calls.map((args) => String(args[0]).split('\n')[0])).toEqual([])
}

function expectJson(res: request.Response, status: number, error: string) {
  expect.soft(res.status).toBe(status)
  expect.soft(res.headers['content-type']).toMatch(/application\/json/)
  expect.soft(res.body).toEqual({ error })
}

test('a malformed JSON body on the public API is a JSON 400, not logged', async () => {
  const cases: Array<[string, string, string]> = [
    ['post', '/api/activate', '{"code":'],
    ['post', '/api/sessions', '{"session_id":'],
    ['delete', '/api/sessions/ses_x', '{bad'],
    // V8 quotes the body around the fault: this would forge a log line.
    ['post', '/api/activate', '{"a": x\n[forged] line\n}'],
  ]
  for (const [method, path, body] of cases) {
    const res = await (method === 'post' ? request(relay).post(path) : request(relay).delete(path))
      .set('Content-Type', 'application/json')
      .send(body)
    expectJson(res, 400, 'invalid json')
  }
  // Outside nginx's exact-match zone for /api/activate: refused before the
  // parser reads the body, so the same JSON, not logged, only a 404.
  for (const path of ['/api/activate/x', '/API/activate']) {
    const res = await request(relay).post(path).set('Content-Type', 'application/json').send('{bad')
    expectJson(res, 404, 'not found')
  }
  await nothingLogged()
})

test('a body in a charset or encoding the parser cannot read is a JSON error, not logged', async () => {
  const charset = await request(relay)
    .post('/api/activate')
    .set('Content-Type', 'application/json; charset=latin1')
    .send('{"code":"x"}')
  expectJson(charset, 415, 'unsupported media type')

  const encoding = await request(relay)
    .post('/api/activate')
    .set('Content-Type', 'application/json')
    .set('Content-Encoding', 'br')
    .send('{"code":"x"}')
  expectJson(encoding, 415, 'unsupported media type')

  // Declared gzip that does not inflate: zlib's error carries no body-parser
  // type, only the 400 the parser gives it.
  const gzip = await request(relay)
    .post('/api/activate')
    .set('Content-Type', 'application/json')
    .set('Content-Encoding', 'gzip')
    .send('not gzip at all')
  expectJson(gzip, 400, 'bad request')
  await nothingLogged()
})

/**
 * The proxy parses only after the viewer check, so an anonymous caller never
 * reaches it; a joined viewer does, through the same final handler.
 */
test("a joined viewer's malformed prompt body is a JSON 400, not logged", async () => {
  const { access_code } = store.createSession('ses_body', '/work', 't', '127.0.0.1')
  const { viewer_token } = store.activate(access_code, 'ses_body')
  const res = await request(relay)
    .post('/session/ses_body/message')
    .set('Cookie', `viewer_token=${viewer_token}`)
    .set('Content-Type', 'application/json')
    .send('{bad')
  expectJson(res, 400, 'invalid json')
  await nothingLogged()
})

/**
 * Not a body, the same final handler: a route parameter that does not decode
 * is express's own 400, and was the same HTML page and stack.
 */
test('a path parameter that does not decode is a JSON 400, not logged', async () => {
  const res = await request(relay).get('/%E0%A4%A/session/ses_body')
  expectJson(res, 400, 'bad request')
  await nothingLogged()
})

test('an oversized public body keeps its JSON 413', async () => {
  const res = await request(relay)
    .post('/api/activate')
    .send({ code: 'A'.repeat(40_000), session_id: 'ses_body' })
  expectJson(res, 413, 'payload too large')
  await nothingLogged()
})
