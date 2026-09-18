import { describe, expect, test } from 'vitest'
import vm from 'node:vm'
import { IDBFactory } from 'fake-indexeddb'
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

/** A profile's localStorage, over the map the tests inspect. */
function memoryLocalStorage(local: Map<string, string>) {
  return {
    get length() {
      return local.size
    },
    key: (i: number) => [...local.keys()][i] ?? null,
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, String(v)),
    removeItem: (k: string) => void local.delete(k),
  }
}

/** One browser profile: its localStorage and its opencode-drafts database. */
function browserProfile(database: 'present' | 'absent' | 'failing' = 'present') {
  const local = new Map<string, string>()
  const localStorage = memoryLocalStorage(local)

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
 * Run the served shell in the profile as a browser parses it: every inline
 * script the relay put in <head>, in order, exactly as served, all in one task.
 */
function runShellScripts(html: string, pathname: string, profile: { localStorage: unknown; indexedDB: unknown }) {
  const head = html.slice(0, html.indexOf('</head>'))
  const scripts = [...head.matchAll(/<script id="oc-relay-[^"]*">([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
  const page: Record<string, unknown> = {
    location: { pathname, origin: 'https://relay.example' },
    localStorage: profile.localStorage,
    indexedDB: profile.indexedDB,
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: () => Promise.reject(new Error('no network here')),
    // A page has timers: a script that defers its work to one gets it run, and
    // is judged by what that does, not by a missing global.
    setTimeout,
    clearTimeout,
    queueMicrotask,
  }
  page.window = page
  vm.createContext(page)
  for (const script of scripts) vm.runInContext(script, page)
}

/** Load the served shell into the profile, and wait out the fake database. */
async function loadShell(html: string, pathname: string, profile: ReturnType<typeof browserProfile>) {
  runShellScripts(html, pathname, profile)
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

/*
 * The fake database above records what the shell's script asks of IndexedDB.
 * Whether share A's prompts reach share B's UI is decided elsewhere: in how
 * that script interleaves with the UI's own open of the same database, which
 * nothing above runs. That is the database's scheduling, per the IndexedDB
 * spec: opens of one name wait on each other in the order they were made (the
 * connection queue); a transaction starts only once every earlier one whose
 * scope it overlaps has finished; an aborted upgrade leaves the version it
 * found, 0 for a database it created. The script relies on all three — its
 * open is made while <head> is parsed, before the UI's deferred bundle runs, so
 * its clear is created before the UI's first transaction — and none of them is
 * in that fake.
 *
 * These run the served shell and the UI's own draft store side by side on
 * fake-indexeddb, an implementation of those rules checked against the web
 * platform tests, in the same browser profile across page loads.
 */

/** A browser profile on a spec-following IndexedDB. */
function specProfile() {
  const local = new Map<string, string>()
  return { local, localStorage: memoryLocalStorage(local), indexedDB: new IDBFactory() }
}

/** Fails with `what` instead of hanging when the UI's store never answers. */
function within<T>(promise: Promise<T>, what: string, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} (nothing after ${ms} ms)`)), ms)
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

/**
 * The UI's draft store, opened and used as upstream opencode does it:
 * createBrowserDraftStore in packages/app/src/utils/draft-store.ts (lines
 * 97-154 at the OPENCODE_REF relay/Dockerfile pins; the built bundle carries it
 * unchanged). Kept as written there: the open at version 1, the stores its
 * upgrade creates, and on every open a readwrite sweep of both stores (read
 * all documents, delete the blobs none refers to) before any get. Two changes,
 * for the test only: the sweep reports what it read, and a blob's id is given
 * rather than hashed from its bytes.
 */
function uiDraftStore(indexedDB: InstanceType<typeof IDBFactory>) {
  const swept: string[][] = []
  const request = indexedDB.open('opencode-drafts', 1)
  request.addEventListener('upgradeneeded', () => {
    request.result.createObjectStore('documents')
    request.result.createObjectStore('blobs')
  })
  const db = new Promise<any>((resolve, reject) => {
    request.addEventListener('success', () => {
      const database = request.result
      const transaction = database.transaction(['documents', 'blobs'], 'readwrite')
      const documents = transaction.objectStore('documents').getAll()
      documents.addEventListener('success', () => {
        swept.push([...documents.result]) // test only
        const used = new Set<string>()
        JSON.parse(`[${documents.result.join(',')}]`, (_key, item) => {
          if (item?.blob && typeof item.blob.id === 'string') used.add(item.blob.id)
          return item
        })
        const blobs = transaction.objectStore('blobs').openKeyCursor()
        blobs.addEventListener('success', () => {
          const cursor = blobs.result
          if (!cursor) return
          if (!used.has(String(cursor.key))) cursor.delete()
          cursor.continue()
        })
      })
      transaction.addEventListener('complete', () => resolve(database))
      transaction.addEventListener('abort', () => resolve(database))
    })
    request.addEventListener('error', () => reject(request.error))
  })
  const get = async (store: string, key: string) => {
    const result = (await db).transaction(store).objectStore(store).get(key)
    return new Promise<unknown>((resolve, reject) => {
      result.addEventListener('success', () => resolve(result.result))
      result.addEventListener('error', () => reject(result.error))
    })
  }
  const write = async (store: string, key: string, value?: unknown) => {
    const transaction = (await db).transaction(store, 'readwrite')
    if (value === undefined) transaction.objectStore(store).delete(key)
    else transaction.objectStore(store).put(value, key)
    return new Promise<void>((resolve, reject) => {
      transaction.addEventListener('complete', () => resolve())
      transaction.addEventListener('error', () => reject(transaction.error))
    })
  }
  const opened = () => within(db, "the UI's draft store never opened")
  return {
    swept,
    get: (key: string) => within(get('documents', key), "the UI's get never answered").then((v) => v ?? null),
    set: (key: string, value: string) => within(write('documents', key, value), "the UI's write never committed"),
    putBlob: (id: string, blob: string) => within(write('blobs', id, blob), "the UI's blob write never committed"),
    getBlob: (id: string) => within(get('blobs', id), "the UI's blob get never answered").then((v) => v ?? null),
    /** Close the tab: its connection goes with it. */
    close: async () => (await opened()).close(),
    opened,
  }
}

const HISTORY = 'opencode.global.dat:prompt-history'
const HISTORY_A = '{"entries":[{"prompt":"PRIVATE-A"}]}'
const DRAFT_A = 'opencode.session.dat:ses_draftsA:prompt'
const DRAFT_A_VALUE = '{"parts":[{"type":"image","blob":{"id":"blob-a"}}]}'

/**
 * A page load: the shell's inline scripts while <head> is parsed, then the UI's
 * bundle, a deferred module, which opens its draft store. The module can run in
 * the very task that ran the scripts, before any database event; that is the
 * closest the UI's open ever follows the script's.
 */
async function openPage(
  html: string,
  pathname: string,
  profile: ReturnType<typeof specProfile>,
  uiOpens: 'in the same task' | 'a task later',
) {
  runShellScripts(html, pathname, profile)
  if (uiOpens === 'a task later') await new Promise((resolve) => setTimeout(resolve, 0))
  return uiDraftStore(profile.indexedDB)
}

/** Share A's page in the profile, left with a sent prompt and a draft with an image. */
async function useShareA(shell: string, profile: ReturnType<typeof specProfile>) {
  const ui = await openPage(shell, uiPath('ses_draftsA'), profile, 'in the same task')
  await ui.set(HISTORY, HISTORY_A)
  await ui.putBlob('blob-a', 'image bytes')
  await ui.set(DRAFT_A, DRAFT_A_VALUE)
  expect(await ui.get(HISTORY)).toBe(HISTORY_A)
  return ui
}

describe.each(['in the same task', 'a task later'] as const)(
  'on a spec-following IndexedDB, with the UI opening its drafts %s as the shell',
  (uiOpens) => {
    test("share B's UI reads nothing of share A's, from its first read on, and a reload keeps B's own", async () => {
      const { app, a, b } = twoShares()
      const shellA = (await request(app).get(uiPath('ses_draftsA')).set('Cookie', a)).text
      const shellB = (await request(app).get(uiPath('ses_draftsB')).set('Cookie', b)).text
      const profile = specProfile()

      // Share A in a browser that never had the database, with the UI's open
      // queued right behind the script's. The script's open would create the
      // database; it aborts that upgrade, and the UI's open at version 1 must
      // still get its own upgrade and stores, or every write here fails.
      const uiA = await useShareA(shellA, profile)
      expect((await uiA.opened()).version).toBe(1)
      expect(uiA.swept).toEqual([[]])
      expect(profile.local.get(MARK)).toBe('ses_draftsA')
      await uiA.close()

      // Share B in the same browser. The UI's first read of the stores is its
      // sweep, made as soon as its open succeeds: the clear must already have
      // run by then, not merely by the time of a later get.
      const uiB = await openPage(shellB, uiPath('ses_draftsB'), profile, uiOpens)
      expect(await uiB.get(HISTORY)).toBeNull()
      expect(uiB.swept).toEqual([[]])
      expect(await uiB.get(DRAFT_A)).toBeNull()
      expect(await uiB.getBlob('blob-a')).toBeNull()
      expect(profile.local.get(MARK)).toBe('ses_draftsB')

      // B's own prompt, then a reload of B: kept.
      await uiB.set(HISTORY, '{"entries":[{"prompt":"OWN-B"}]}')
      await uiB.close()
      const reloaded = await openPage(shellB, uiPath('ses_draftsB'), profile, uiOpens)
      expect(await reloaded.get(HISTORY)).toBe('{"entries":[{"prompt":"OWN-B"}]}')
      expect(reloaded.swept).toEqual([['{"entries":[{"prompt":"OWN-B"}]}']])
      await reloaded.close()
    })

    test("a tab of share A left open holds up neither the clear nor share B's UI", async () => {
      const { app, a, b } = twoShares()
      const shellA = (await request(app).get(uiPath('ses_draftsA')).set('Cookie', a)).text
      const shellB = (await request(app).get(uiPath('ses_draftsB')).set('Cookie', b)).text
      const profile = specProfile()

      // Still open, and like upstream it has no versionchange handler: it
      // would never give way to a delete or an upgrade another tab asked for.
      const uiA = await useShareA(shellA, profile)

      const uiB = await openPage(shellB, uiPath('ses_draftsB'), profile, uiOpens)
      expect(await uiB.get(HISTORY)).toBeNull()
      expect(uiB.swept).toEqual([[]])
      expect(await uiB.getBlob('blob-a')).toBeNull()
      expect(profile.local.get(MARK)).toBe('ses_draftsB')
      await uiB.close()
      await uiA.close()
    })
  },
)
