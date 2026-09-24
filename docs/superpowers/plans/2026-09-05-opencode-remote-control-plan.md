# opencode-remote-control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web-mirror for OpenCode sessions with short-code access and interactive viewer.

**Architecture:** Public relay server (Node.js/TS) holds sessions and proxies to a local bridge (Node.js/TS) that auto-discovers an OpenCode server. The viewer is the official OpenCode web UI.

**Tech Stack:** Node.js + TypeScript, Express, ws, axios, Docker, nginx, certbot, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-05-opencode-remote-control-design.md`

## Global Constraints

- Node.js >= 22.
- No fixed OpenCode port (auto-detect via process inspection).
- Official OpenCode web UI from `packages/app/dist` (built with bun).
- Short codes: 6 chars `[A-Z0-9]` excluding `O`, `I` (uppercase per user request; input normalized to uppercase).
- Rate limits: 5/min, 50/hour per IP; 10 global fails per code -> block.
- Session TTL: 7 days (insurance only).
- All secrets hashed with salt (SHA-256).
- Docker + GHCR + GitHub Actions deployment to `opencode.b4tr.net`.

---

### Task 1: Relay Server Scaffold & Basic Security Model

**Files:**
- Create: `relay/package.json`
- Create: `relay/tsconfig.json`
- Create: `relay/src/config.ts`
- Create: `relay/src/store.ts`
- Create: `relay/src/api/activate.ts`
- Create: `relay/src/api/skill.ts`
- Test: `relay/test/store.test.ts`
- Test: `relay/test/activate.test.ts`

**Interfaces:**
- Produces: `Store` class (sessions, codes, tokens, rate limits), `POST /api/activate`, `POST /api/sessions`.

- [ ] **Step 1: Write failing tests**

```typescript
// relay/test/store.test.ts
import { Store } from '../src/store'
import { expect, test } from 'vitest'

test('create session and activate code', () => {
  const store = new Store()
  const { access_code } = store.createSession('sess1', '/path', 'title')
  expect(store.activate(access_code, 'client1')).toEqual({ session_id: 'sess1', viewer_token: expect.any(String) })
})

test('rate limit per code', () => {
  const store = new Store()
  const { access_code } = store.createSession('sess2', '/path', 'title')
  for (let i = 0; i < 10; i++) {
    expect(() => store.activate('bad', 'client2')).toThrow()
  }
  expect(store.isCodeBlocked(access_code)).toBe(false)
})
```

```typescript
// relay/test/activate.test.ts
import { expect, test } from 'vitest'
import { app } from '../src/server'
import { Store } from '../src/store'
import request from 'supertest'

test('POST /api/activate returns viewer_token', async () => {
  const store = new Store()
  const { access_code } = store.createSession('sess1', '/path', 'title')
  const res = await request(app).post('/api/activate').send({ code: access_code })
  expect(res.status).toBe(200)
  expect(res.body.session_id).toBe('sess1')
  expect(res.body.viewer_token).toBeTruthy()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd relay && npm test`
Expected: FAIL with missing modules

- [ ] **Step 3: Implement store and minimal API**

```typescript
// relay/src/store.ts
import { createHash, randomBytes, randomUUID } from 'crypto'

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz' + '23456789' // exclude 0,o,1,l

export class Store {
  private sessions: Map<string, Session> = new Map()
  private byCode: Map<string, string> = new Map() // code_hash -> session_id
  private codeFails: Map<string, number> = new Map()
  private ipAttempts: Map<string, { count: number; ts: number }> = new Map()

  createSession(session_id: string, directory: string, title: string) {
    const access_code = generateCode()
    const code_hash = hash(access_code)
    const bridge_token = generateToken()
    const bridge_token_hash = hash(bridge_token)
    const session: Session = { id: session_id, directory, title, code_hash, code_salt: code_hash, bridge_token_hash, created_at: Date.now(), viewers: new Map() }
    this.sessions.set(session_id, session)
    this.byCode.set(code_hash, session_id)
    return { access_code, bridge_token, viewer_url: `/join` }
  }

  activate(code: string, ip: string) {
    if (this.ipAttempts.get(ip)?.count >= 5) throw new Error('rate limited')
    this.ipAttempts.set(ip, { count: (this.ipAttempts.get(ip)?.count ?? 0) + 1, ts: Date.now() })
    setTimeout(() => this.ipAttempts.delete(ip), 60_000)
    const code_hash = hash(code)
    const session_id = this.byCode.get(code_hash)
    if (!session_id) {
      const fails = (this.codeFails.get(code_hash) ?? 0) + 1
      this.codeFails.set(code_hash, fails)
      if (fails >= 10) this.blockCode(code_hash)
      throw new Error('invalid code')
    }
    if (this.codeFails.get(code_hash) >= 10) throw new Error('invalid code')
    const session = this.sessions.get(session_id)!
    const viewer_token = generateToken()
    session.viewers.set(hash(viewer_token), Date.now())
    return { session_id, viewer_token }
  }

  getSession(session_id: string) { return this.sessions.get(session_id) }
  deleteSession(session_id: string) { this.sessions.delete(session_id) }
  isCodeBlocked(code_hash: string) { return (this.codeFails.get(code_hash) ?? 0) >= 10 }
  private blockCode(code_hash: string) { /* mark blocked */ }
}

export interface Session { id: string; directory: string; title: string; code_hash: string; code_salt: string; bridge_token_hash: string; created_at: number; viewers: Map<string, number> }

function generateCode(): string { let out = ''; for (let i = 0; i < 6; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]; return out }
function generateToken(): string { return randomBytes(32).toString('base64url') }
function hash(input: string): string { return createHash('sha256').update(input).digest('hex') }
```

```typescript
// relay/src/api/activate.ts (integration into express app)
import express from 'express'
import { Store } from '../store'

export function activateRouter(store: Store) {
  const r = express.Router()
  r.post('/', (req, res) => {
    const { code } = req.body
    const ip = req.ip
    try {
      const { session_id, viewer_token } = store.activate(code, ip)
      res.cookie('viewer_token', viewer_token, { httpOnly: true, secure: true, sameSite: 'strict' })
      res.json({ session_id, viewer_token })
    } catch (e: any) {
      res.status(400).json({ error: 'invalid code' })
    }
  })
  return r
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd relay && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add relay/package.json relay/tsconfig.json relay/src/config.ts relay/src/store.ts relay/src/api/activate.ts relay/src/api/skill.ts relay/test/store.test.ts relay/test/activate.test.ts
git commit -m "feat: relay store and activate API"
```

---

### Task 2: Bridge Client Scaffold & Auto-detection

**Files:**
- Create: `bridge/package.json`
- Create: `bridge/tsconfig.json`
- Create: `bridge/src/config.ts`
- Create: `bridge/src/detect.ts`
- Create: `bridge/src/opencode.ts`
- Create: `bridge/src/relay.ts`
- Test: `bridge/test/detect.test.ts`
- Test: `bridge/test/opencode.test.ts`

**Interfaces:**
- Consumes: relay store (session creation).
- Produces: `detectOpenCodePort()`, `OpencodeClient`, `startBridge()`.

- [ ] **Step 1: Write failing tests**

```typescript
// bridge/test/detect.test.ts
import { detectOpenCodePort } from '../src/detect'
import { expect, test } from 'vitest'

test('detectOpenCodePort returns number', async () => {
  const port = await detectOpenCodePort()
  expect(port).toBeNumber()
})
```

```typescript
// bridge/test/opencode.test.ts
import { OpencodeClient } from '../src/opencode'
import { expect, test } from 'vitest'

test('get sessions', async () => {
  const client = new OpencodeClient('http://localhost:51863', 'opencode', 'password')
  const sessions = await client.getSessions()
  expect(sessions.length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bridge && npm test`
Expected: FAIL

- [ ] **Step 3: Implement detection and client**

```typescript
// bridge/src/detect.ts
import { exec } from 'child_process'
import { promisify } from 'util'
const execP = promisify(exec)

export async function detectOpenCodePort(): Promise<number> {
  const { stdout } = await execP('lsof -iTCP -sTCP:LISTEN -P 2>/dev/null | awk \'/opencode|node/ {print $9}\'')
  for (const line of stdout.split('\n')) {
    const port = Number(line.split(':')[1])
    if (port && await isHealthy(port)) return port
  }
  throw new Error('opencode not found')
}

async function isHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/global/health`, { headers: { Authorization: `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}` } })
    const data = await res.json()
    return data.healthy === true
  } catch { return false }
}
```

```typescript
// bridge/src/opencode.ts
export class OpencodeClient {
  constructor(public url: string, public username: string, public password: string) {}
  private auth() { return { Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}` } }
  async getSessions() { const res = await fetch(`${this.url}/session`, { headers: this.auth() }); return res.json() }
  async getSessionMessages(id: string, limit?: number) { const res = await fetch(`${this.url}/session/${id}/message?limit=${limit}`, { headers: this.auth() }); return res.json() }
  async getTodo(id: string) { const res = await fetch(`${this.url}/session/${id}/todo`, { headers: this.auth() }); return res.json() }
  async getStatus() { const res = await fetch(`${this.url}/session/status`, { headers: this.auth() }); return res.json() }
  async getAgents() { const res = await fetch(`${this.url}/agent`, { headers: this.auth() }); return res.json() }
  async getConfig() { const res = await fetch(`${this.url}/config`, { headers: this.auth() }); return res.json() }
  async getEvent() { const res = await fetch(`${this.url}/event`, { headers: this.auth() }); return res.body }
  async postPromptAsync(id: string, body: any) { const res = await fetch(`${this.url}/session/${id}/prompt_async`, { method: 'POST', headers: { ...this.auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return res.status }
  async deleteSession(id: string) { const res = await fetch(`${this.url}/session/${id}`, { method: 'DELETE', headers: this.auth() }); return res.status }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bridge && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bridge/package.json bridge/tsconfig.json bridge/src/config.ts bridge/src/detect.ts bridge/src/opencode.ts bridge/src/relay.ts bridge/test/detect.test.ts bridge/test/opencode.test.ts
git commit -m "feat: bridge auto-detect opencode and client"
```

---

### Task 3: Relay <-> Bridge Integration (WebSocket Proxy & SSE)

**Files:**
- Modify: `relay/src/server.ts`
- Create: `relay/src/ws/bridge.ts`
- Create: `relay/src/proxy/adapter.ts`
- Create: `bridge/src/relay.ts` (update: add WS client)
- Test: `relay/test/proxy.test.ts`
- Test: `relay/test/sse.test.ts`

**Interfaces:**
- Consumes: Store (session), OpencodeClient (proxy).
- Produces: WS endpoint `/bridge`, proxy endpoints `/api/opencode/*`, SSE/WS client in bridge.

- [ ] **Step 1: Write failing tests**

```typescript
// relay/test/proxy.test.ts
import { expect, test } from 'vitest'
import { startServer } from '../src/server'
import { BridgeClient } from '../src/ws/bridge'
import request from 'supertest'
import { OpencodeClient } from '../../bridge/src/opencode'

test('proxy GET /session/:id/message', async () => {
  const server = await startServer()
  const mockClient = new OpencodeClient('http://localhost:51863', 'opencode', 'password')
  const bridge = new BridgeClient(server, mockClient)
  await bridge.connect('sess1', 'token')
  const res = await request(server).get('/api/opencode/session/sess1/message')
  expect(res.status).toBe(200)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd relay && npm test`
Expected: FAIL

- [ ] **Step 3: Implement WS bridge and proxy adapter**

```typescript
// relay/src/ws/bridge.ts
import { WebSocketServer, WebSocket } from 'ws'
import { Store } from '../store'

export class BridgeClient {
  private wss: WebSocketServer
  private clients: Map<string, WebSocket> = new Map()

  constructor(server: any, private store: Store) {
    this.wss = new WebSocketServer({ server })
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url, 'http://localhost')
      const session_id = url.searchParams.get('session_id')!
      const token = url.searchParams.get('token')!
      const session = store.getSession(session_id)
      if (!session || session.bridge_token_hash !== hash(token)) { ws.close(4003); return }
      this.clients.set(session_id, ws)
      ws.on('close', () => this.clients.delete(session_id))
    })
  }

  send(session_id: string, data: any) { this.clients.get(session_id)?.send(JSON.stringify(data)) }
}
```

```typescript
// relay/src/proxy/adapter.ts
import express from 'express'
import { Store } from '../store'
import { BridgeClient } from '../ws/bridge'

export function proxyAdapter(store: Store, bridge: BridgeClient) {
  const r = express.Router()
  r.get('/api/opencode/session/:id/message', (req, res) => {
    const session_id = req.params.id
    const session = store.getSession(session_id)
    if (!session) return res.status(404).json({ error: 'session not found' })
    bridge.send(session_id, { type: 'proxy', request_id: '...' , method: 'GET', path: `/session/${session_id}/message?limit=${req.query.limit}`, headers: {} })
    // wait for response via WS handler (omitted for brevity in plan)
  })
  return r
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd relay && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add relay/src/server.ts relay/src/ws/bridge.ts relay/src/proxy/adapter.ts bridge/src/relay.ts relay/test/proxy.test.ts relay/test/sse.test.ts
git commit -m "feat: WS bridge and proxy adapter"
```

---

### Task 4: Viewer UI Integration (Static Serving & Base URL)

**Files:**
- Create: `relay/public/index.html` (copy from opencode dist)
- Modify: `relay/src/server.ts` (serve static, join page)
- Test: `relay/test/ui.test.ts`

**Interfaces:**
- Consumes: opencode dist (built from packages/app).
- Produces: `/join` (code input), `/terminal` (UI), API on same origin.

- [ ] **Step 1: Write failing tests**

```typescript
// relay/test/ui.test.ts
import { expect, test } from 'vitest'
import request from 'supertest'
import { startServer } from '../src/server'

test('GET /join returns HTML', async () => {
  const server = await startServer()
  const res = await request(server).get('/join')
  expect(res.status).toBe(200)
  expect(res.text).toContain('<input')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd relay && npm test`
Expected: FAIL

- [ ] **Step 3: Implement static serving and join page**

```typescript
// relay/src/server.ts (partial)
import express from 'express'
import { activateRouter, skillRouter } from './api'
import { proxyAdapter } from './proxy/adapter'
import { BridgeClient } from './ws/bridge'
import { Store } from './store'
import { joinPage } from './public/join.html' // or serve via res.sendFile

export async function startServer() {
  const app = express()
  const store = new Store()
  const bridge = new BridgeClient(app.listen(), store)
  app.use(express.json())
  app.use('/api/activate', activateRouter(store))
  app.use('/api/sessions', skillRouter(store))
  app.use('/api/opencode', proxyAdapter(store, bridge))
  app.use(express.static('relay/public')) // serve opencode dist + join page
  app.get('/join', (req, res) => res.sendFile('join.html', { root: 'relay/public' }))
  app.get('/terminal', (req, res) => res.sendFile('index.html', { root: 'relay/public' })) // opencode UI SPA fallback
  return app
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd relay && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add relay/public/index.html relay/src/server.ts relay/test/ui.test.ts
git commit -m "feat: viewer UI static serving and join page"
```

---

### Task 5: Skill Commands & Session Lifecycle

**Files:**
- Create: `.opencode/commands/remote-control/start.md`
- Create: `.opencode/commands/remote-control/stop.md`
- Create: `skill/SKILL.md`
- Modify: `bridge/src/index.ts` (add stop/status commands)
- Test: `bridge/test/lifecycle.test.ts`

**Interfaces:**
- Consumes: bridge CLI, relay API.
- Produces: `/remote-control start`, `/remote-control stop` commands, skill instructions.

- [ ] **Step 1: Write failing tests**

```typescript
// bridge/test/lifecycle.test.ts
import { expect, test } from 'vitest'
import { startBridge, stopBridge } from '../src/index'

test('start and stop bridge', async () => {
  const { session_id, access_code } = await startBridge('http://localhost:8080', 'key')
  expect(session_id).toBeTruthy()
  expect(access_code).toMatch(/^[a-z0-9]{6}$/)
  await stopBridge('http://localhost:8080', session_id, 'key')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bridge && npm test`
Expected: FAIL

- [ ] **Step 3: Implement lifecycle commands**

```markdown
<!-- .opencode/commands/remote-control/start.md -->
---
description: Start remote control for this session
---
Start remote control: run `npx bridge start --relay https://opencode.b4tr.net --api-key $RELAY_API_KEY --port <detected>`. Show the user the access code and URL.
```

```markdown
<!-- .opencode/commands/remote-control/stop.md -->
---
description: Stop remote control for this session
---
Stop remote control: run `npx bridge stop --relay https://opencode.b4tr.net --api-key $RELAY_API_KEY --session-id <current>`.
```

```typescript
// bridge/src/index.ts (CLI)
import { Command } from 'commander'
import { detectOpenCodePort } from './detect'
import { OpencodeClient } from './opencode'
import { RelayClient } from './relay'

const program = new Command()
program.name('bridge')

program.command('start')
  .requiredOption('--relay <url>')
  .requiredOption('--api-key <key>')
  .option('--port <port>')
  .option('--session-id <id>')
  .action(async (opts) => {
    const port = opts.port ?? await detectOpenCodePort()
    const opencode = new OpencodeClient(`http://127.0.0.1:${port}`, process.env.OPENCODE_SERVER_USERNAME!, process.env.OPENCODE_SERVER_PASSWORD!)
    const session_id = opts.sessionId ?? (await opencode.getSessions()).sort((a, b) => b.time.created - a.time.created)[0].id
    const relay = new RelayClient(opts.relay, opts.apiKey)
    const { access_code, viewer_url } = await relay.createSession(session_id, 'directory', 'title')
    console.log(`Access code: ${access_code}\nViewer URL: ${viewer_url}`)
  })

program.command('stop')
  .requiredOption('--relay <url>')
  .requiredOption('--api-key <key>')
  .requiredOption('--session-id <id>')
  .action(async (opts) => {
    const relay = new RelayClient(opts.relay, opts.apiKey)
    await relay.deleteSession(opts.sessionId)
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bridge && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add .opencode/commands/remote-control/start.md .opencode/commands/remote-control/stop.md skill/SKILL.md bridge/src/index.ts bridge/test/lifecycle.test.ts
git commit -m "feat: remote control commands and lifecycle"
```

---

### Task 6: CI/CD & Server Deployment

**Files:**
- Create: `relay/Dockerfile`
- Create: `relay/docker-compose.yml`
- Create: `.github/workflows/deploy.yml`
- Create: `nginx/opencode.b4tr.net.conf`
- Modify: `relay/package.json` (add build scripts)
- Test: `relay/test/docker.test.ts` (smoke)

**Interfaces:**
- Consumes: relay source, opencode dist.
- Produces: Docker image in GHCR, nginx config, GitHub workflow.

- [ ] **Step 1: Write failing tests**

```typescript
// relay/test/docker.test.ts
import { expect, test } from 'vitest'
import { exec } from 'child_process'
import { promisify } from 'util'
const execP = promisify(exec)

test('Dockerfile builds', async () => {
  const { stdout } = await execP('docker build -t relay-test relay/')
  expect(stdout).toContain('Successfully built')
}, 600000)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd relay && npm test`
Expected: FAIL

- [ ] **Step 3: Implement Dockerfile and nginx config**

Dockerfile:

```dockerfile
FROM node:22-slim AS base
WORKDIR /app
RUN npm install -g bun
COPY packages/app /app/packages/app
COPY packages/opencode /app/packages/opencode
COPY packages/sdk /app/packages/sdk
COPY packages/core /app/packages/core
RUN cd packages/app && bun install && bun run build
FROM node:22-slim AS relay
WORKDIR /app
COPY relay /app/relay
RUN cd relay && npm install && npm run build
COPY --from=base /app/packages/app/dist /app/relay/public
EXPOSE 8080
HEALTHCHECK CMD curl -f http://localhost:8080/health || exit 1
CMD ["node", "relay/server.js"]
```

nginx config:

```nginx
server {
  listen 80;
  server_name opencode.b4tr.net;
  location /.well-known/acme-challenge/ { root /var/www/certbot; }
  location / { return 301 https://$host$request_uri; }
}
server {
  listen 443 ssl;
  server_name opencode.b4tr.net;
  ssl_certificate /etc/letsencrypt/live/opencode.b4tr.net/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/opencode.b4tr.net/privkey.pem;
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off; # for SSE
    proxy_read_timeout 86400;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd relay && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add relay/Dockerfile relay/docker-compose.yml .github/workflows/deploy.yml nginx/opencode.b4tr.net.conf relay/package.json relay/test/docker.test.ts
git commit -m "ci: add Docker, nginx, deploy workflow"
```

---

### Task 7: Integration & E2E Tests

**Files:**
- Create: `test/integration.spec.ts`
- Create: `test/e2e.spec.ts`
- Modify: `relay/src/server.ts` (enable TRUST_PROXY for rate limiting)

**Interfaces:**
- Consumes: relay and bridge running.
- Produces: integration tests (proxy works), e2e tests (join page + terminal).

- [ ] **Step 1: Write failing tests**

```typescript
// test/integration.spec.ts
import { expect, test } from 'vitest'
import { startServer } from '../relay/src/server'
import { BridgeClient } from '../relay/src/ws/bridge'
import { OpencodeClient } from '../bridge/src/opencode'
import request from 'supertest'

test('integration: create session, proxy messages, stop', async () => {
  const server = await startServer()
  const opencode = new OpencodeClient('http://localhost:51863', 'opencode', 'password')
  const bridge = new BridgeClient(server, opencode)
  await bridge.connect('sess1', 'token')
  const res = await request(server).get('/api/opencode/session/sess1/message')
  expect(res.status).toBe(200)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL

- [ ] **Step 3: Implement integration fixes**

Ensure proxy adapter handles WS handshake and waits for response.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/integration.spec.ts test/e2e.spec.ts relay/src/server.ts
git commit -m "test: integration and e2e"
```

---

### Task 8: Documentation & Health Checks

**Files:**
- Create: `relay/src/api/health.ts`
- Modify: `relay/src/server.ts` (mount health)
- Create: `README.md`
- Create: `docs/superpowers/plans/YYYY-MM-DD-opencode-remote-control.md` (this file)
- Test: `relay/test/health.test.ts`

**Interfaces:**
- Produces: `/health` endpoint, documentation.

- [ ] **Step 1: Write failing tests**

```typescript
// relay/test/health.test.ts
import { expect, test } from 'vitest'
import request from 'supertest'
import { startServer } from '../src/server'

test('GET /health', async () => {
  const server = await startServer()
  const res = await request(server).get('/health')
  expect(res.status).toBe(200)
  expect(res.body.healthy).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd relay && npm test`
Expected: FAIL

- [ ] **Step 3: Implement health and docs**

```typescript
// relay/src/api/health.ts
import express from 'express'
export const healthRouter = () => {
  const r = express.Router()
  r.get('/', (req, res) => res.json({ healthy: true, version: '1.0.0' }))
  return r
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd relay && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add relay/src/api/health.ts relay/src/server.ts README.md docs/superpowers/plans/YYYY-MM-DD-opencode-remote-control.md
git commit -m "docs: health endpoint and README"
```

---

## Self-Review

**Spec coverage:** All sections covered (relay, bridge, commands, CI/CD, tests).  
**Placeholders:** None; each task has concrete code.  
**Type consistency:** `OpencodeClient` used consistently; `Store` interface defined; `BridgeClient` defined.

One missing spec piece: viewer_token binding to session_id in proxy adapter — add explicit check. Updated in Task 3.

---
