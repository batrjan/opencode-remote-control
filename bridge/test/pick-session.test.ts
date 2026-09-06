import { expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OpencodeClient } from '../src/opencode'

/**
 * pickSession must choose the newest ROOT session in the CURRENT working
 * directory. The opencode instance (e.g. the desktop app) hosts many projects
 * at once; an unfiltered GET /session returns sessions from ALL of them and
 * would pick an unrelated project (observed: sharing the wrong session).
 */
test('getSessions(directory) filters to the current project', async () => {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    const all = [
      { id: 'ses_lampa', directory: '/Users/x/lampa', title: 'lampa', time: { created: 300 } },
      { id: 'ses_proj', directory: '/proj', title: 'proj', time: { created: 100 } },
    ]
    const dir = url.searchParams.get('directory')
    res.end(JSON.stringify(dir ? all.filter((s) => s.directory === dir) : all))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const client = new OpencodeClient(`http://127.0.0.1:${port}`, 'o', 'p')
  const inProj = (await client.getSessions('/proj')) as Array<{ id: string }>
  expect(inProj.map((s) => s.id)).toEqual(['ses_proj'])
  const all = (await client.getSessions()) as Array<{ id: string }>
  expect(all.length).toBe(2)
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
})
