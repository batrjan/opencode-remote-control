import { expect, test } from 'vitest'
import request from 'supertest'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/server'
import { Store } from '../src/store'
import { viewerTokenFrom } from './helpers/viewer-token'

process.env.ACTIVATE_FAIL_DELAY_MS = '0'

/**
 * What an owner reads about the life of their access code has to be what the
 * relay does with it.
 *
 * The README said a code and its viewer tokens lasted until the share ended,
 * and the "Ownership of the link" row said the owner key "lets a restart take
 * back a share whose bridge died" — with nothing about the code and the
 * viewers of that share, which every registration silently replaced. An owner
 * who handed a code to somebody in another country had no way to read, from
 * the documents, that the code would stop working the next time their laptop
 * went down, nor that stopping the share is still what revokes it.
 *
 * Each assertion runs the behaviour against a real Store first, so the day the
 * relay changes its mind about any of it, the documents have to change too.
 */

const README = fileURLToPath(new URL('../../README.md', import.meta.url))
const DEPLOY = fileURLToPath(new URL('../../DEPLOY.md', import.meta.url))

/** A markdown table, from its header row to the blank line that ends it. */
function table(header: string): string {
  const lines = fs.readFileSync(README, 'utf8').split('\n')
  const start = lines.findIndex((l) => l.startsWith(header))
  expect(start, `no table starting ${header}`).toBeGreaterThan(-1)
  const rows: string[] = []
  for (const line of lines.slice(start)) {
    if (line.trim() === '') break
    rows.push(line)
  }
  return rows.join('\n')
}

function row(header: string, lead: string): string {
  const found = table(header)
    .split('\n')
    .find((l) => l.startsWith(lead))
  expect(found, `no row starting ${lead}`).toBeDefined()
  return found!
}

const OWNER_KEY = randomBytes(32).toString('base64url')

/** A live share with one viewer in it, over the real app. */
async function share(app: ReturnType<typeof createApp>, session_id: string) {
  const created = await request(app)
    .post('/api/sessions')
    .send({ session_id, directory: '/work', title: 't', owner_key: OWNER_KEY })
  expect(created.status).toBe(201)
  const joined = await request(app)
    .post('/api/activate')
    .send({ code: created.body.access_code, session_id })
  expect(joined.status).toBe(200)
  return { code: created.body.access_code as string, token: viewerTokenFrom(joined), bridge_token: created.body.bridge_token as string }
}

test('the security table describes the code and viewers a restart keeps, and what still revokes them', async () => {
  const store = new Store()
  const app = createApp(store)
  const live = await share(app, 'ses_docs_resume')

  // Kept: same install, same code.
  const again = await request(app)
    .post('/api/sessions')
    .send({ session_id: 'ses_docs_resume', directory: '/work', title: 't', owner_key: OWNER_KEY, access_code: live.code })
  expect(again.body.access_code, 'a restart no longer keeps the code — the README row must change').toBe(live.code)
  expect(store.verifyViewer('ses_docs_resume', live.token)).toBe(true)

  // Revoked: stop.
  expect(
    (await request(app).delete('/api/sessions/ses_docs_resume').set('x-bridge-token', again.body.bridge_token)).status,
  ).toBe(204)
  expect(store.verifyViewer('ses_docs_resume', live.token)).toBe(false)
  const after = await request(app)
    .post('/api/sessions')
    .send({ session_id: 'ses_docs_resume', directory: '/work', title: 't', owner_key: OWNER_KEY, access_code: live.code })
  expect(after.body.access_code, 'a stopped share no longer gets a new code — the README row must change').not.toBe(live.code)

  const detail = row('| What protects the share |', '| How long the code and the viewers last |')
  expect(detail, 'the row does not say the code survives a restart').toMatch(/keeps the access code/i)
  expect(detail, 'the row does not say the viewer tokens survive it').toMatch(/viewer token/i)
  expect(detail, 'the row does not name the state file the code is presented from').toContain('owner key')
  // The whole point of writing it down: what still ends access.
  for (const revocation of ['/remote-control/stop', 'reaping', 'another install']) {
    expect(detail, `the row does not name ${revocation} as something that still revokes`).toContain(revocation)
  }
  // And the reservation row must not still promise only the id back.
  expect(row('| What protects the share |', '| Ownership of the link |')).toMatch(/access code and its viewers/i)
})

test('the endpoint table documents access_code, including the 400 a malformed one gets', async () => {
  const store = new Store()
  const app = createApp(store)
  const live = await share(app, 'ses_docs_resume_api')
  const bad = await request(app)
    .post('/api/sessions')
    .send({ session_id: 'ses_docs_resume_api', directory: '/work', title: 't', owner_key: OWNER_KEY, access_code: 42 })
  expect(bad.status, 'a malformed access_code is no longer a 400 — the endpoint row must change').toBe(400)
  expect(store.verifyViewer('ses_docs_resume_api', live.token)).toBe(true)

  const endpoint = row('| Endpoint ', '| `POST /api/sessions`')
  expect(endpoint, 'the endpoint row never names access_code').toContain('access_code')
  expect(endpoint, 'the endpoint row does not give the refusal a malformed one gets').toContain('400')
  expect(endpoint, 'the endpoint row does not say the relay only recognises a code').toMatch(/salted hash/i)
})

/**
 * The operator's side: a rolled-back relay is not a broken one, but while it
 * is up an owner's restart costs them their viewers, and that is the kind of
 * thing a rollback note has to say out loud.
 */
test('DEPLOY says what a relay rolled back past this costs an owner', () => {
  const deploy = fs.readFileSync(DEPLOY, 'utf8')
  const note = deploy.slice(deploy.indexOf('A relay rolled back past share resumption'))
  expect(note.length, 'DEPLOY carries no rollback note for share resumption').toBeGreaterThan(0)
  expect(note.slice(0, 900)).toMatch(/access_code/)
  expect(note.slice(0, 900)).toMatch(/loses the viewers/i)
})
