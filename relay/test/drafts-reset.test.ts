import { expect, test } from 'vitest'
import vm from 'node:vm'
import request from 'supertest'
import { createApp } from '../src/server'
import { Store } from '../src/store'

/**
 * Prompts typed into one share must not turn up in another share opened later
 * in the same browser.
 *
 * Every share is served from the relay's one origin, and the UI keeps what it
 * calls drafts in IndexedDB ("opencode-drafts"), which the relay's reset of
 * the UI's localStorage never touched. Among those drafts is the prompt
 * history, which the UI keeps per browser, not per session or server
 * ("opencode.global.dat:prompt-history", up to 100 entries, written as a
 * prompt is sent). Reproduced in a real browser against two live shares: a
 * prompt sent in share A came back in share B's empty input on the first
 * ArrowUp — also after share A had been stopped and its tokens revoked. The
 * unsent draft of A's session sat there too, for DevTools or a later share of
 * that same session to find. Upstream opencode web has one owner per origin;
 * the relay puts shares of different owners on one.
 *
 * So the UI shell clears those stores when the browser moves to a different
 * share, and leaves them alone on a reload within the share, where they are
 * the viewer's own.
 */

const DIR = '/work'
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const uiPath = (id: string) => `/${b64url(DIR)}/session/${id}`

/** Which share the browser's drafts belong to, as the shell records it. */
const MARK = 'relay-drafts-share'

/** One browser profile: its localStorage and its opencode-drafts database. */
function browserProfile(database: 'present' | 'absent' | 'failing' = 'present') {
  const local = new Map<string, string>()
  const localStorage = {
    get length() {
      return local.size
    },
    key: (i: number) => [...local.keys()][i] ?? null,
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, String(v)),
    removeItem: (k: string) => void local.delete(k),
  }

  // The UI's documents and blobs stores, with what share A left in them.
  let exists = database === 'present'
  const stores = new Map<string, Map<string, unknown>>()
  const seed = () => {
    stores.set('documents', new Map([['opencode.global.dat:prompt-history', '{"entries":[{"prompt":"PRIVATE-A"}]}']]))
    stores.set('blobs', new Map([['blob1', 'image bytes']]))
  }
  if (exists) seed()

  const log: string[] = []
  const later = (fn: () => void) => setTimeout(fn, 0)
  const fire = (target: Record<string, unknown>, type: string) => {
    const handler = target[`on${type}`]
    if (typeof handler === 'function') handler.call(target, { type, target })
  }

  const indexedDB = {
    open(name: string, version?: number) {
      log.push(version === undefined ? `open ${name}` : `open ${name} v${version}`)
      const req: Record<string, unknown> = {}
      const db = {
        objectStoreNames: { contains: (n: string) => stores.has(n) },
        createObjectStore: (n: string) => {
          log.push(`createObjectStore ${n}`)
          stores.set(n, new Map())
        },
        transaction(names: string[] | string, mode?: string) {
          const scope = Array.isArray(names) ? names : [names]
          log.push(`transaction ${scope.join(',')} ${mode ?? 'readonly'}`)
          const tx: Record<string, unknown> = {
            objectStore: (n: string) => ({
              clear: () => {
                log.push(`clear ${n}`)
                stores.get(n)?.clear()
                return {}
              },
            }),
          }
          later(() => fire(tx, 'complete'))
          return tx
        },
        close: () => log.push('close'),
      }
      later(() => {
        if (database === 'failing') return fire(req, 'error')
        req.result = db
        if (!exists) {
          // A database that does not exist is created at version 1 for an
          // open without a version, through an upgrade transaction.
          let aborted = false
          req.transaction = {
            abort: () => {
              log.push('abort upgrade')
              aborted = true
            },
          }
          fire(req, 'upgradeneeded')
          req.transaction = null
          if (aborted) {
            stores.clear()
            req.result = undefined
            return fire(req, 'error')
          }
          exists = true
        }
        fire(req, 'success')
      })
      return req
    },
    deleteDatabase: (name: string) => {
      log.push(`deleteDatabase ${name}`)
      return {}
    },
  }

  return { local, stores, log, localStorage, indexedDB }
}

/** Wait out the fake database's callbacks. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

/**
 * Load the served shell into the profile as a browser would: every inline
 * script the relay put in <head>, in order, exactly as served.
 */
async function loadShell(html: string, pathname: string, profile: ReturnType<typeof browserProfile>) {
  const head = html.slice(0, html.indexOf('</head>'))
  const scripts = [...head.matchAll(/<script id="oc-relay-[^"]*">([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
  const page: Record<string, unknown> = {
    location: { pathname, origin: 'https://relay.example' },
    localStorage: profile.localStorage,
    indexedDB: profile.indexedDB,
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: () => Promise.reject(new Error('no network here')),
  }
  page.window = page
  vm.createContext(page)
  for (const script of scripts) vm.runInContext(script, page)
  await settle()
}

function twoShares() {
  const store = new Store()
  const app = createApp(store)
  const viewer = (id: string) => {
    const { access_code } = store.createSession(id, DIR, 't', '127.0.0.1')
    const { viewer_token } = store.activate(access_code, id)
    return `viewer_token=${viewer_token}`
  }
  return { app, a: viewer('ses_draftsA'), b: viewer('ses_draftsB') }
}

test("a share opened after another in the same browser starts without the other share's drafts and prompt history", async () => {
  const { app, a, b } = twoShares()
  const shellA = await request(app).get(uiPath('ses_draftsA')).set('Cookie', a)
  expect(shellA.status).toBe(200)
  const shellB = await request(app).get(uiPath('ses_draftsB')).set('Cookie', b)
  expect(shellB.status).toBe(200)

  // Classic inline in <head>: it runs during parsing, while the UI's bundle is
  // a module script and runs only after that, so this open is queued ahead of
  // the UI's own (and the clear ahead of the UI's first read).
  const at = shellB.text.indexOf('<script id="oc-relay-drafts-reset">')
  expect(at, 'no drafts reset in the served UI shell').toBeGreaterThan(-1)
  expect(at).toBeLessThan(shellB.text.indexOf('</head>'))
  expect(shellB.text).toMatch(/<script type="module"[^>]* src="\/assets\/index-[^"]+\.js">/)

  // The browser was last used for share A, and remembers that.
  const profile = browserProfile()
  profile.local.set(MARK, 'ses_draftsA')

  await loadShell(shellB.text, uiPath('ses_draftsB'), profile)
  // Opened without a version, so it never upgrades the UI's database, and
  // cleared in place rather than deleted: the UI has no versionchange handler,
  // so another open tab would block a delete and hang this tab's own open.
  expect(profile.log).toEqual([
    'open opencode-drafts',
    'transaction documents,blobs readwrite',
    'clear documents',
    'clear blobs',
    'close',
  ])
  expect(profile.stores.get('documents')!.size).toBe(0)
  expect(profile.stores.get('blobs')!.size).toBe(0)
  // Recorded once the clear has committed, under a key the localStorage reset
  // that runs before it on every load does not remove.
  expect(profile.local.get(MARK)).toBe('ses_draftsB')
  expect(profile.local.get('opencode.settings.dat:defaultServerUrl')).toBe('https://relay.example')
})

test('a browser with no record of a share clears the drafts it finds', async () => {
  const { app, a } = twoShares()
  const shell = await request(app).get(uiPath('ses_draftsA')).set('Cookie', a)
  const profile = browserProfile()
  await loadShell(shell.text, uiPath('ses_draftsA'), profile)
  expect(profile.log).toContain('clear documents')
  expect(profile.log).toContain('clear blobs')
  expect(profile.stores.get('documents')!.size).toBe(0)
  expect(profile.local.get(MARK)).toBe('ses_draftsA')
})

test("a reload within the share keeps the viewer's own drafts and history", async () => {
  const { app, a } = twoShares()
  const shell = await request(app).get(uiPath('ses_draftsA')).set('Cookie', a)
  const profile = browserProfile()
  profile.local.set(MARK, 'ses_draftsA')

  await loadShell(shell.text, uiPath('ses_draftsA'), profile)
  expect(profile.log).toEqual([])
  expect(profile.stores.get('documents')!.size).toBe(1)

  // The same holds on a subagent's page of that share: it is served at the
  // subagent's id, but it is the same share's page, and the drafts are the
  // viewer's own.
  const child = await request(app).get(uiPath('ses_draftsAchild')).set('Cookie', a)
  expect(child.status).toBe(200)
  await loadShell(child.text, uiPath('ses_draftsAchild'), profile)
  expect(profile.log).toEqual([])
  expect(profile.stores.get('documents')!.size).toBe(1)
  expect(profile.local.get(MARK)).toBe('ses_draftsA')
})

test('a browser that never had the database gets none made for it', async () => {
  const { app, a } = twoShares()
  const shell = await request(app).get(uiPath('ses_draftsA')).set('Cookie', a)
  const profile = browserProfile('absent')
  await loadShell(shell.text, uiPath('ses_draftsA'), profile)
  // Letting that open create the database would leave an empty version 1 with
  // no stores, and the UI's open at version 1 would then never upgrade it.
  expect(profile.log).toEqual(['open opencode-drafts', 'abort upgrade'])
  expect(profile.stores.size).toBe(0)
  expect(profile.local.get(MARK)).toBe('ses_draftsA')
})

test('a database that fails to open is tried again on the next load', async () => {
  const { app, a } = twoShares()
  const shell = await request(app).get(uiPath('ses_draftsA')).set('Cookie', a)
  const profile = browserProfile('failing')
  await loadShell(shell.text, uiPath('ses_draftsA'), profile)
  expect(profile.log).toEqual(['open opencode-drafts'])
  // Nothing was cleared, so the browser must not be taken as this share's yet.
  expect(profile.local.has(MARK)).toBe(false)
})

test('a share id is written into the shell as data, whatever it holds', async () => {
  const store = new Store()
  const app = createApp(store)
  const id = 'x</script><script>globalThis.injected=1</script>'
  const { access_code } = store.createSession(id, DIR, 't', '127.0.0.1')
  const { viewer_token } = store.activate(access_code, id)
  // Its page is a subagent-style one: no page route answers such an id, but
  // the cookie names the share.
  const shell = await request(app).get(uiPath('ses_draftsOdd')).set('Cookie', `viewer_token=${viewer_token}`)
  expect(shell.status).toBe(200)
  expect(shell.text).not.toContain('<script>globalThis.injected')
  const profile = browserProfile()
  await loadShell(shell.text, uiPath('ses_draftsOdd'), profile)
  expect(profile.local.get(MARK)).toBe(id)
})

test('/terminal names no share and leaves the drafts alone', async () => {
  const app = createApp(new Store())
  const shell = await request(app).get('/terminal')
  expect(shell.status).toBe(200)
  const profile = browserProfile()
  await loadShell(shell.text, '/terminal', profile)
  expect(profile.log).toEqual([])
  expect(profile.local.has(MARK)).toBe(false)
})

test('a browser without IndexedDB still loads the shell', async () => {
  const { app, a } = twoShares()
  const shell = await request(app).get(uiPath('ses_draftsA')).set('Cookie', a)
  const profile = browserProfile()
  const broken = { ...profile, indexedDB: undefined as unknown as typeof profile.indexedDB }
  await expect(loadShell(shell.text, uiPath('ses_draftsA'), broken)).resolves.toBeUndefined()
  expect(profile.local.get('opencode.settings.dat:defaultServerUrl')).toBe('https://relay.example')
})
