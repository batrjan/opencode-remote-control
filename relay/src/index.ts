import { startServer } from './server.js'
import { config } from './config.js'

/**
 * Runtime entrypoint (Docker CMD, `npm start`). server.ts only exports
 * factories so tests can inject their own Store; this module wires the
 * process-level server.
 */
const server = await startServer()
console.log(`[relay] listening on :${config.port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
