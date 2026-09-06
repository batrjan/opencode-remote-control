import { expect, test } from 'vitest'
// @ts-expect-error — the plugin entries are plain ESM JavaScript, no types.
import serverPlugin, {
  createHooks,
  defaultRegisterCommands,
  runsTui,
  server,
  tuiEntryRegistered,
} from '../../plugin/server.js'
// @ts-expect-error — same.
import tuiPlugin from '../../plugin/remote-control.js'
// @ts-expect-error — same.
import { resolveAction } from '../../plugin/bridge-runner.js'

/**
 * The desktop GUI and `opencode run` have no TUI, so the slash commands cannot
 * come from the TUI plugin there. The server entry registers the same commands
 * through the config hook and executes them in `command.execute.before`.
 *
 * A plugin module may export EITHER server() or tui(), never both — the loader
 * rejects a module that has both — so the two entries must stay separate.
 */

test('the two entry points export exactly one kind each', () => {
  expect(typeof serverPlugin.server).toBe('function')
  expect('tui' in serverPlugin).toBe(false)
  expect(typeof tuiPlugin.tui).toBe('function')
  expect('server' in tuiPlugin).toBe(false)
  expect(serverPlugin.id).toBe(tuiPlugin.id)
})

test('the config hook registers the commands clients without a TUI can see', async () => {
  const hooks = createHooks(async () => 'unused', () => true)
  const config: { command?: Record<string, { description?: string; template?: string }> } = {}
  await hooks.config!(config)
  expect(Object.keys(config.command!)).toEqual([
    'remote-control',
    'remote-control/start',
    'remote-control/stop',
    'remote-control/status',
  ])
  for (const entry of Object.values(config.command!)) {
    expect(entry.description).toBeTruthy()
    expect(entry.template).toBeTruthy()
  }
})

test('the config hook never overwrites a command the user defined', async () => {
  const hooks = createHooks(async () => 'unused', () => true)
  const mine = { description: 'mine', template: 'mine' }
  const config = { command: { 'remote-control': mine } }
  await hooks.config!(config)
  expect(config.command['remote-control']).toBe(mine)
  expect(config.command['remote-control/start']).toBeTruthy()
})

test('command.execute.before runs the action and appends its output IN PLACE', async () => {
  // opencode keeps a reference to output.parts — reassigning the array drops
  // the injected text and the model only ever sees the template.
  const seen: Array<[string, string | undefined]> = []
  const hooks = createHooks(async (action: string, sessionID?: string) => {
    seen.push([action, sessionID])
    return 'https://relay/ses_x\nCODE: ABC123'
  })
  const parts: unknown[] = []
  const output = { parts }
  await hooks['command.execute.before']!(
    { command: 'remote-control/start', sessionID: 'ses_x', arguments: '' },
    output as never,
  )
  expect(seen).toEqual([['start', 'ses_x']])
  expect(output.parts).toBe(parts)
  expect(parts).toEqual([{ type: 'text', text: 'https://relay/ses_x\nCODE: ABC123' }])
})

test('command.execute.before ignores commands that are not ours', async () => {
  const hooks = createHooks(async () => {
    throw new Error('must not run for foreign commands')
  })
  const output = { parts: [] as unknown[] }
  await hooks['command.execute.before']!(
    { command: 'review', sessionID: 'ses_x', arguments: '' },
    output as never,
  )
  expect(output.parts).toEqual([])
})

test('a failing action is reported in the message, never thrown', async () => {
  const hooks = createHooks(async () => {
    throw new Error('relay unreachable')
  })
  const output = { parts: [] as Array<{ text: string }> }
  await expect(
    hooks['command.execute.before']!(
      { command: 'remote-control/start', sessionID: 'ses_x', arguments: '' },
      output as never,
    ),
  ).resolves.toBeUndefined()
  expect(output.parts).toEqual([{ type: 'text', text: 'remote-control start failed: relay unreachable' }])
})

test('server() returns the same hook surface', async () => {
  const hooks = await server()
  expect(typeof hooks.config).toBe('function')
  expect(typeof hooks['command.execute.before']).toBe('function')
})

test('resolveAction reads the action from the command name or the arguments', () => {
  expect(resolveAction('remote-control/start', '')).toBe('start')
  expect(resolveAction('remote-control/stop', '')).toBe('stop')
  expect(resolveAction('remote-control', 'start')).toBe('start')
  expect(resolveAction('remote-control', 'stop extra words')).toBe('stop')
  // Bare `/remote-control` with no argument is a safe read-only report.
  expect(resolveAction('remote-control', '')).toBe('status')
  expect(resolveAction('remote-control', 'nonsense')).toBe('status')
})

/**
 * De-duplication. A terminal-UI process runs BOTH loaders: the TUI entry
 * registers the commands natively and the server entry would register the same
 * names as config commands, so every one of them showed up twice in the `/`
 * menu. The server entry steps aside there — but only when the TUI entry is
 * actually installed, or the terminal would end up with no commands at all.
 */
test('runsTui recognises a terminal-UI launch', () => {
  expect(runsTui([], {})).toBe(true)
  expect(runsTui(['--print-logs'], {})).toBe(true)
  expect(runsTui(['/path/to/project'], {})).toBe(true)
  expect(runsTui([], { OPENCODE_CLIENT: 'cli' })).toBe(true)
})

test('runsTui rejects clients that never render a TUI', () => {
  for (const argv of [['serve'], ['run', 'hello'], ['web'], ['acp'], ['attach', 'url']]) {
    expect(runsTui(argv, {})).toBe(false)
  }
  expect(runsTui([], { OPENCODE_CLIENT: 'desktop' })).toBe(false)
  expect(runsTui([], { OPENCODE_CLIENT: 'acp' })).toBe(false)
})

test('tuiEntryRegistered finds the plugin in a tui.json', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'rc-tui-'))
  const configDir = nodePath.join(root, 'config')
  const project = nodePath.join(root, 'project')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(nodePath.join(project, '.opencode'), { recursive: true })
  const env = { OPENCODE_CONFIG_DIR: configDir, HOME: root } as NodeJS.ProcessEnv

  expect(tuiEntryRegistered(project, env)).toBe(false)

  writeFileSync(nodePath.join(configDir, 'tui.json'), JSON.stringify({ plugin: ['some-other-plugin'] }))
  expect(tuiEntryRegistered(project, env)).toBe(false)

  writeFileSync(
    nodePath.join(configDir, 'tui.json'),
    JSON.stringify({ plugin: ['opencode-remote-control@git+https://example/repo.git'] }),
  )
  expect(tuiEntryRegistered(project, env)).toBe(true)

  // Project-level config counts too, and a tuple entry is unwrapped.
  writeFileSync(nodePath.join(configDir, 'tui.json'), JSON.stringify({ plugin: [] }))
  writeFileSync(
    nodePath.join(project, '.opencode', 'tui.json'),
    JSON.stringify({ plugin: [['../plugin/remote-control.js', {}]] }),
  )
  expect(tuiEntryRegistered(project, env)).toBe(true)
})

test('tuiEntryRegistered survives a malformed config instead of throwing', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'rc-tui-bad-'))
  const configDir = nodePath.join(root, 'config')
  mkdirSync(configDir, { recursive: true })
  const env = { OPENCODE_CONFIG_DIR: configDir, HOME: root } as NodeJS.ProcessEnv
  writeFileSync(nodePath.join(configDir, 'tui.json'), '{ /* jsonc */ "plugin": ["opencode-remote-control"] }')
  expect(tuiEntryRegistered(root, env)).toBe(true)
  writeFileSync(nodePath.join(configDir, 'tui.json'), '{ not json at all')
  expect(tuiEntryRegistered(root, env)).toBe(false)
})

test('the config hook registers nothing when the TUI entry owns the commands', async () => {
  const hooks = createHooks(async () => 'unused', () => false)
  const config: { command?: Record<string, unknown> } = {}
  await hooks.config!(config)
  expect(config.command).toBeUndefined()
})

test('defaultRegisterCommands only steps aside for a TUI that has the TUI entry', () => {
  // The real predicate reads this process and the on-disk tui.json files; it
  // must return a boolean and never throw, whatever the environment looks like.
  expect(typeof defaultRegisterCommands()).toBe('boolean')
})
