import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import vm from 'node:vm'
import request from 'supertest'
import { viewerTokenFrom } from './helpers/viewer-token'
import { startServer } from '../src/server'
import { OpencodeClient } from '../../bridge/src/opencode'
import { RelayWSClient } from '../../bridge/src/relay'

/**
 * A subagent's page, loaded as a page: a reload, a new tab, a pasted link.
 *
 * When the agent runs the task tool, the transcript shows a card for the
 * subagent that links to its own session page, /<base64url(dir)>/session/<child>
 * (or /server/<base64url(server)>/session/<child>), and the web UI deliberately
 * leaves a middle-click or a ctrl/meta-click on it to the browser. The relay
 * answered those URLs from its share list alone, which holds only the shared
 * session, so the viewer's reload of a subagent page, or the tab they opened
 * for it, said "This session has ended" while the share was live and their
 * cookie was fine. Read as the share being over.
 *
 * The page is the static UI shell; everything it then reads still goes through
 * the proxy's forced binding, where a subagent is proven by its parent chain.
 * So a viewer with a working cookie gets the shell for any session id, and
 * nobody else gets anything they did not get before.
 *
 * Real relay, real bridge client, mock opencode with the share, a subagent, a
 * nested one and an unrelated session.
 */

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

const DIR = '/work/route-proj'
const SHARE = 'ses_routeShare01'
const CHILD = 'ses_routeChild01'
const GRAND = 'ses_routeGrand01'
const STRANGER = 'ses_routeStranger01'

const info = (id: string, parentID?: string) => ({
  id,
  ...(parentID ? { parentID } : {}),
  directory: DIR,
  title: id,
  time: { created: 1, updated: 1 },
})
const SESSIONS = new Map([
  [SHARE, info(SHARE)],
  [CHILD, info(CHILD, SHARE)],
  [GRAND, info(GRAND, CHILD)],
  [STRANGER, info(STRANGER)],
])

let relay: Server
let relayUrl: string
let opencode: Server
let bridge: RelayWSClient
let viewerToken: string
/** Session details opencode was asked for, in order. */
const detailReads: string[] = []

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  opencode = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    const detail = /^\/session\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && detail) {
      const id = decodeURIComponent(detail[1]!)
      detailReads.push(id)
      const found = SESSIONS.get(id)
      return found ? json(res, 200, found) : json(res, 404, { error: 'not found' })
    }
    json(res, 404, { error: 'mock: no route' })
  })
  await new Promise<void>((resolve) => opencode.listen(0, '127.0.0.1', resolve))
  const opencodeUrl = `http://127.0.0.1:${(opencode.address() as AddressInfo).port}`

  relay = await startServer(0)
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`
  const created = await request(relay).post('/api/sessions').send({ session_id: SHARE, directory: DIR, title: 'shared' })
  expect(created.status).toBe(201)
  const activated = await request(relay).post('/api/activate').send({ code: created.body.access_code, session_id: SHARE })
  expect(activated.status).toBe(200)
  viewerToken = viewerTokenFrom(activated)

  bridge = new RelayWSClient(relayUrl, new OpencodeClient(opencodeUrl, 'opencode', 'password'))
  await bridge.connect(SHARE, created.body.bridge_token, DIR)
})

afterAll(async () => {
  bridge?.close()
  relay?.closeAllConnections()
  await new Promise((resolve) => relay.close(resolve))
  opencode?.closeAllConnections()
  await new Promise((resolve) => opencode.close(resolve))
})

beforeEach(() => {
  detailReads.length = 0
})

const cookie = () => `viewer_token=${viewerToken}`
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
/** Both spellings the UI links a session page by. */
const pagePaths = (id: string) => [`/${b64url(DIR)}/session/${id}`, `/server/${b64url(relayUrl)}/session/${id}`]

/** A GET as the page's own fetch would see it: a real Response, body unread. */
async function pageFetch(viewerCookie: string, path: string): Promise<Response> {
  const res = await request(relay).get(path).set('Cookie', viewerCookie)
  const headers = new Headers()
  for (const [name, value] of Object.entries(res.headers)) {
    if (typeof value === 'string') headers.set(name, value)
  }
  return new Response(res.text, { status: res.status, headers })
}

test('reloading a subagent page, or opening it in a new tab, serves the viewer the UI', async () => {
  for (const id of [CHILD, GRAND]) {
    for (const path of pagePaths(id)) {
      const res = await request(relay).get(path).set('Cookie', cookie())
      expect(res.status, path).toBe(200)
      expect(res.headers['content-type'], path).toContain('text/html')
      expect(res.text, path).toContain('<script id="oc-relay-server-url">')
      expect(res.text, path).not.toContain('This session has ended')
      // A page load is use, like any request: the cookie slides with it.
      expect(String(res.headers['set-cookie']), path).toContain('viewer_token=')
    }
  }
  // Nothing went upstream to serve a page.
  expect(detailReads).toEqual([])
})

test("what the subagent page then reads is the subagent's own, and its parent walk ends at the share", async () => {
  // The UI's rootSession walk from the nested subagent's page.
  const grand = await request(relay).get(`/session/${GRAND}`).set('Cookie', cookie())
  expect(grand.body).toMatchObject({ id: GRAND, parentID: CHILD })
  const child = await request(relay).get(`/session/${CHILD}`).set('Cookie', cookie())
  expect(child.body).toMatchObject({ id: CHILD, parentID: SHARE })
  const share = await request(relay).get(`/session/${SHARE}`).set('Cookie', cookie())
  expect(share.body.id).toBe(SHARE)
  expect(share.body.parentID).toBeUndefined()

  // A page naming an unrelated session reads as the share, as before.
  const stranger = await request(relay).get(`/session/${STRANGER}`).set('Cookie', cookie())
  expect(stranger.body.id).toBe(SHARE)
  expect(stranger.body.parentID).toBeUndefined()
})

test('the /api spelling of the session detail reaches the proxy, not the page routes', async () => {
  // '/:dir/session/:id' matched /api/session/<id> with dir = 'api', so the
  // proxy's /api twin was never reached: HTML for the share's own id, the ended
  // page for anything else.
  const child = await request(relay).get(`/api/session/${CHILD}`).set('Cookie', cookie())
  expect(child.status).toBe(200)
  expect(child.headers['content-type']).toContain('application/json')
  expect(child.body).toMatchObject({ id: CHILD, parentID: SHARE })

  for (const auth of [['Cookie', cookie()], ['x-viewer-token', viewerToken]] as const) {
    const share = await request(relay).get(`/api/session/${SHARE}`).set(auth[0], auth[1])
    expect(share.status, auth[0]).toBe(200)
    expect(share.headers['content-type'], auth[0]).toContain('application/json')
    expect(share.body.id, auth[0]).toBe(SHARE)
  }

  // Without a viewer it is the proxy's marked 401, not a page.
  const anonymous = await request(relay).get(`/api/session/${CHILD}`)
  expect(anonymous.status).toBe(401)
  expect(anonymous.headers['content-type']).toContain('application/json')
})

test("a subagent page sends a viewer whose access ended to the share's page, not the subagent's", async () => {
  const [path] = pagePaths(CHILD)
  const shell = await request(relay).get(path!).set('Cookie', cookie())
  expect(shell.status).toBe(200)
  const script = /<script id="oc-relay-auth-guard">([\s\S]*?)<\/script>/.exec(shell.text)?.[1]
  expect(script).toBeDefined()

  // Run the guard as the browser would on that page, then have the relay
  // refuse the viewer (a token it no longer knows) on the event stream.
  const replace = vi.fn()
  const page: Record<string, unknown> = {
    fetch: (p: string) => pageFetch('viewer_token=no-longer-valid', p),
    location: { pathname: path, replace, reload: vi.fn() },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  }
  page.window = page
  vm.createContext(page)
  vm.runInContext(script!, page)
  const res = await (page.fetch as (p: string) => Promise<Response>)('/global/event')
  expect(res.status).toBe(401)
  expect(replace.mock.calls.map(([to]) => to)).toEqual([`/${SHARE}`])

  // Why the share's page: it offers the code field for this live share, while
  // the subagent's id names no share and would say it has ended.
  const landing = await request(relay).get(`/${SHARE}`).set('Cookie', 'viewer_token=no-longer-valid')
  expect(landing.status).toBe(200)
  expect(landing.text).toContain(`window.__OC_SESSION_ID__="${SHARE}"`)
  const childEntry = await request(relay).get(`/${CHILD}`).set('Cookie', 'viewer_token=no-longer-valid')
  expect(childEntry.text).toContain('This session has ended')
})

test('nobody without a working cookie gets anything new', async () => {
  // A share that has since ended leaves a cookie that names nothing.
  const gone = await request(relay).post('/api/sessions').send({ session_id: 'ses_routeGone01', directory: DIR, title: 't' })
  expect(gone.status).toBe(201)
  const goneViewer = await request(relay)
    .post('/api/activate')
    .send({ code: gone.body.access_code, session_id: 'ses_routeGone01' })
  expect(goneViewer.status).toBe(200)
  const deleted = await request(relay).delete('/api/sessions/ses_routeGone01').set('x-bridge-token', gone.body.bridge_token)
  expect(deleted.status).toBe(204)

  for (const viewerCookie of [undefined, 'viewer_token=forged', `viewer_token=${viewerTokenFrom(goneViewer)}`]) {
    for (const id of [CHILD, 'ses_routeGone01']) {
      for (const path of pagePaths(id)) {
        const req = request(relay).get(path)
        const res = await (viewerCookie ? req.set('Cookie', viewerCookie) : req)
        expect(res.status, `${path} ${viewerCookie}`).toBe(404)
        expect(res.text, `${path} ${viewerCookie}`).toContain('This session has ended')
        expect(res.text, `${path} ${viewerCookie}`).not.toContain('oc-relay-server-url')
      }
    }
  }
})

test("a viewer's cookie still does not open another live share's page", async () => {
  const other = await request(relay).post('/api/sessions').send({ session_id: 'ses_routeOther01', directory: DIR, title: 't' })
  expect(other.status).toBe(201)
  try {
    for (const path of pagePaths('ses_routeOther01')) {
      const res = await request(relay).get(path).set('Cookie', cookie())
      // That share's own code-entry page, exactly as before.
      expect(res.status, path).toBe(302)
      expect(res.headers.location, path).toBe('/ses_routeOther01')
    }
  } finally {
    await request(relay).delete('/api/sessions/ses_routeOther01').set('x-bridge-token', other.body.bridge_token)
  }
})
