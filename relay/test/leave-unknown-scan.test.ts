import { expect, test } from 'vitest'
import express from 'express'
import request from 'supertest'
import { leaveRouter } from '../src/api/leave'
import type { Store } from '../src/store'

/**
 * POST /api/leave is unauthenticated by design — it is a logout, and it answers
 * 204 whether or not the token it was handed exists, so it cannot be used as an
 * oracle for whether a token is live. That is exactly why the WORK it does must
 * depend on the token being real: ending a viewer's streams walks every open
 * stream in the process (one process serves every tenant's share), and an
 * anonymous caller could make the relay do that walk once per request by
 * presenting a token that never existed.
 *
 * Nothing needs ending when nothing was revoked, so nothing is walked.
 */

/** A store that answers revokeViewer with `dropped` and counts the calls. */
function countingStore(dropped: boolean) {
  const calls: string[] = []
  const store = {
    revokeViewer(token: string) {
      calls.push(token)
      return dropped
    },
  } as unknown as Store
  return { store, calls }
}

function appWith(store: Store, onEnd: (token: string) => void) {
  const app = express()
  app.use('/api/leave', leaveRouter(store, onEnd))
  return app
}

test('a token that was never valid does not make the relay walk its stream table', async () => {
  const { store, calls } = countingStore(false)
  const ended: string[] = []
  const res = await request(appWith(store, (t) => void ended.push(t)))
    .post('/api/leave')
    .set('x-viewer-token', 'v_totally-made-up-token')

  // Still a logout, still the same answer: no oracle is introduced.
  expect(res.status).toBe(204)
  expect(calls, 'the token was not even looked up').toEqual(['v_totally-made-up-token'])
  expect(ended, 'an unknown token walked every open viewer stream').toEqual([])
})

test('a real viewer leaving still has their streams ended at once', async () => {
  const { store } = countingStore(true)
  const ended: string[] = []
  const res = await request(appWith(store, (t) => void ended.push(t)))
    .post('/api/leave')
    .set('x-viewer-token', 'v_real-token')

  expect(res.status).toBe(204)
  expect(ended, 'the viewer who asked to leave kept their live feed').toEqual(['v_real-token'])
})
