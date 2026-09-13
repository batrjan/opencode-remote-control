import { shutdown, startServer } from './server.js'
import { config } from './config.js'

/**
 * Runtime entrypoint (Docker CMD, `npm start`). server.ts only exports
 * factories so tests can inject their own Store; this module wires the
 * process-level server.
 */
const server = await startServer()
console.log(`[relay] listening on :${config.port}`)

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    // Persists first, then ends the viewers' streams rather than cutting them
    // (see shutdown() for why that order matters to the web UI).
    void shutdown(server).then(() => process.exit(0))
    // Hard deadline: never let a stuck connection block the redeploy.
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
