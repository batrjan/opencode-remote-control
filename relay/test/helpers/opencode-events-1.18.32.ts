/**
 * Event payloads captured from a live opencode 1.18.32 `GET /event` stream.
 *
 * Recorded 2026-09-22 against `~/.opencode/bin/opencode` 1.18.32 running
 * `serve` in an isolated HOME/XDG over a throwaway git project, while a script
 * created a pty, appended to the TUI prompt, raised a TUI toast, executed a TUI
 * command, changed files on disk and switched branch. Verbatim except for the
 * machine-specific project path, rewritten to `/home/owner/proj`, and the
 * `pid`.
 *
 * They exist so the event filter is tested against what opencode actually
 * emits rather than against payloads written from the spec. The spec's Event
 * union has 89 kinds on 1.18.32; 31 of them carry no session id anywhere, and
 * the ones below are that family's representatives.
 */

/** The owner's terminal: its command line, its arguments and its cwd. */
export const PTY_CREATED = JSON.stringify({
  id: 'evt_0c827e545001YDdOl0nouF7zWS',
  type: 'pty.created',
  properties: {
    info: {
      id: 'pty_0c827e524001fT25Rb6aL8S1LY',
      title: 'owner-shell',
      command: '/bin/sh',
      args: ['-c', 'echo OWNER_SECRET_COMMAND; sleep 20', '-l'],
      cwd: '/home/owner/proj',
      status: 'running',
      pid: 4242,
    },
  },
})

/** What the owner is typing into their OWN TUI, character by character. */
export const TUI_PROMPT_APPEND = JSON.stringify({
  id: 'evt_0c827e54d001ZUsH7qF0UxMmOQ',
  type: 'tui.prompt.append',
  properties: { text: 'owner is typing a private note' },
})

/** The owner's own toasts — error text, and the paths in it. */
export const TUI_TOAST_SHOW = JSON.stringify({
  id: 'evt_0c827e551001k27Zv1u0vyV7yZ',
  type: 'tui.toast.show',
  properties: { title: 'owner toast', message: 'failed: /home/owner/private/path', variant: 'error', duration: 5000 },
})

/** A command the owner ran in their own TUI. */
export const TUI_COMMAND_EXECUTE = JSON.stringify({
  id: 'evt_0c827e5550017NlmrUl2Xwm939',
  type: 'tui.command.execute',
  properties: { command: 'session.new' },
})

/** Which plugins the owner has loaded. */
export const PLUGIN_ADDED = JSON.stringify({
  id: 'evt_0c827deb600123F9FUWpsX5DpE',
  type: 'plugin.added',
  properties: { id: 'core/config-reference' },
})

/** A file the opencode edit/write tool touched. The web UI ignores this kind. */
export const FILE_EDITED = JSON.stringify({
  id: 'evt_0c827f1120010iF6lDuns0qrJ4',
  type: 'file.edited',
  properties: { file: '/home/owner/proj/src/secret.ts' },
})

/** The project record: worktree path, vcs, the owner's project commands. */
export const PROJECT_UPDATED = JSON.stringify({
  id: 'evt_0c827f1120010iF6lDuns0qrK5',
  type: 'project.updated',
  properties: {
    id: 'global',
    worktree: '/home/owner/proj',
    vcs: 'git',
    name: 'proj',
    time: { created: 1758537600000, initialized: 1758537600000 },
  },
})

/** Which other directories the owner has open in this project. */
export const PROJECT_DIRECTORIES_UPDATED = JSON.stringify({
  id: 'evt_0c827f1120010iF6lDuns0qrL6',
  type: 'project.directories.updated',
  properties: { projectID: 'global' },
})

/** A worktree the owner created. `/experimental/worktree` is not proxied. */
export const WORKTREE_READY = JSON.stringify({
  id: 'evt_0c827f1120010iF6lDuns0qrM7',
  type: 'worktree.ready',
  properties: { name: 'owner-secret-feature', branch: 'owner-secret-branch' },
})

/** An error with no session: its message is the owner's, not the share's. */
export const SESSION_ERROR_GLOBAL = JSON.stringify({
  id: 'evt_0c827f1120010iF6lDuns0qrN8',
  type: 'session.error',
  properties: { error: { name: 'ProviderAuthError', data: { providerID: 'anthropic', message: 'no key at /home/owner/.config/x' } } },
})

// ---- the kinds a viewer keeps ----

/** opencode's handshake frame, first on every /event stream. */
export const SERVER_CONNECTED = JSON.stringify({
  id: 'evt_0c827d9bc001Zy75d76mQLI6Lx',
  type: 'server.connected',
  properties: {},
})

/** opencode's own keep-alive, seen every ~10 s on a live 1.18.32 stream. */
export const SERVER_HEARTBEAT = JSON.stringify({
  id: 'evt_0c82800d1001FlBuRQfNdXCsNH',
  type: 'server.heartbeat',
  properties: {},
})

/** Empty payload; the UI refetches GET /lsp, which the viewer may already read. */
export const LSP_UPDATED = JSON.stringify({
  id: 'evt_0c827df59001tSgxrvvYBY0zfQ',
  type: 'lsp.updated',
  properties: {},
})

/** Empty payload; the UI refetches GET /experimental/resource. */
export const REFERENCE_UPDATED = JSON.stringify({
  id: 'evt_0c827df5e002ve4v0ZI45ABc7l',
  type: 'reference.updated',
  properties: {},
})

/** The shared worktree's branch — what GET /vcs already serves the viewer. */
export const VCS_BRANCH_UPDATED = JSON.stringify({
  id: 'evt_0c827f14e0011ZOUm4c8m8dmfl',
  type: 'vcs.branch.updated',
  properties: { branch: 'owner-secret-branch' },
})

/** A path under the shared directory, which the viewer's file routes list anyway. */
export const FILE_WATCHER_UPDATED = JSON.stringify({
  id: 'evt_0c827f14a0016j0HYCMiVU2pH8',
  type: 'file.watcher.updated',
  properties: { file: '/home/owner/proj/.git/index', event: 'add' },
})

/** Every captured payload that carries no session id and must be dropped. */
export const LEAKY_GLOBAL_EVENTS: Array<[string, string]> = [
  ['pty.created', PTY_CREATED],
  ['tui.prompt.append', TUI_PROMPT_APPEND],
  ['tui.toast.show', TUI_TOAST_SHOW],
  ['tui.command.execute', TUI_COMMAND_EXECUTE],
  ['plugin.added', PLUGIN_ADDED],
  ['file.edited', FILE_EDITED],
  ['project.updated', PROJECT_UPDATED],
  ['project.directories.updated', PROJECT_DIRECTORIES_UPDATED],
  ['worktree.ready', WORKTREE_READY],
  ['session.error (no session)', SESSION_ERROR_GLOBAL],
]

/** Every captured payload that carries no session id and is forwarded anyway. */
export const KEPT_GLOBAL_EVENTS: Array<[string, string]> = [
  ['server.connected', SERVER_CONNECTED],
  ['server.heartbeat', SERVER_HEARTBEAT],
  ['lsp.updated', LSP_UPDATED],
  ['reference.updated', REFERENCE_UPDATED],
  ['vcs.branch.updated', VCS_BRANCH_UPDATED],
  ['file.watcher.updated', FILE_WATCHER_UPDATED],
]
