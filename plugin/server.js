// Server-side stub for the remote-control plugin.
// The loader requires a server() entry for every plugin; ours does nothing —
// all functionality lives in the TUI plugin (./tui → ./remote-control.js).
export default { id: 'remote-control', server: async () => ({}) }
