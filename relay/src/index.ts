import type http from 'node:http'
import { startServer } from './server.js'
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
    // Persist NOW, before anything can hang: an open viewer SSE stream keeps
    // server.close() pending, so relying on the 'close' event to flush would
    // lose the last snapshot on a redeploy — exactly when it matters.
    ;(server as http.Server & { flushState?: () => void }).flushState?.()
    // Drop lingering connections (SSE streams) so close() can actually finish.
    server.closeAllConnections?.()
    server.close(() => process.exit(0))
    // Hard deadline: never let a stuck connection block the redeploy.
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
