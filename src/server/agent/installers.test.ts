import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KIMI_HOOK_EVENTS,
  codexHookRegistryState,
  hooksState,
  installHooks,
  installPluginHooks,
  opencodePluginJs,
  pluginHooksState,
  tomlHooksInstall,
  tomlHooksState,
  tomlHooksUninstall,
} from './installers.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_program, _args, _options, callback) => callback(null, '', '')),
  spawn: vi.fn(),
}));

describe('native Agent hook updates', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-native-hooks-'));
    vi.spyOn(os, 'homedir').mockReturnValue(dir);
    vi.stubEnv('CODEX_HOME', path.join(dir, 'custom-codex'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(dir, 'custom-claude'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('updates the active Codex home, keeps user hooks, and detects missing lifecycle coverage', async () => {
    const file = path.join(process.env.CODEX_HOME!, 'hooks.json');
    const userHook = { hooks: [{ type: 'command', command: 'my-own-hook' }] };
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [userHook] } }));

    await installHooks('codex');
    expect(hooksState('codex')).toBe('installed');
    const once = fs.readFileSync(file, 'utf8');
    const root = JSON.parse(once);
    expect(root.hooks.PreToolUse[0]).toEqual(userHook);
    expect(root.hooks.PreToolUse[1].hooks[0].command).toContain('agent-hook codex tool-start');
    expect(root.hooks.Interrupt[0].hooks[0].command).toContain('agent-hook codex stop');
    expect(fs.existsSync(path.join(dir, '.codex', 'hooks.json'))).toBe(false);
    await installHooks('codex');
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
    delete root.hooks.UserPromptSubmit;
    fs.writeFileSync(file, JSON.stringify(root));
    expect(hooksState('codex')).toBe('outdated');
  });

  it('installs Claude permission and question events as distinct blocking signals', async () => {
    await installHooks('claude');
    const root = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8'));
    expect(root.hooks.PermissionRequest[0].hooks[0].command).toContain('agent-hook claude permission-request');
    expect(root.hooks.PreToolUse[0].hooks[0].command).toContain('agent-hook claude tool-start');
    expect(hooksState('claude')).toBe('installed');
  });

  it('checks every enabled, trusted Codex event instead of counting duplicate hook entries', async () => {
    await installHooks('codex');
    const root = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME!, 'hooks.json'), 'utf8'));
    const hooks = Object.entries(root.hooks).map(([event, entries]) => ({
      eventName: event[0].toLowerCase() + event.slice(1),
      command: (entries as Array<{ hooks: Array<{ command: string }> }>)[0].hooks[0].command,
      enabled: true, trustStatus: 'trusted',
    }));
    expect(codexHookRegistryState(hooks)).toBe('installed');
    expect(codexHookRegistryState(hooks.map(hook => hook.eventName === 'userPromptSubmit' ? { ...hook, enabled: false } : hook))).toBe('needs-approval');
    expect(codexHookRegistryState(hooks.map(hook => hook.eventName === 'stop' ? { ...hook, trustStatus: 'untrusted' } : hook))).toBe('needs-approval');
    expect(codexHookRegistryState(hooks.map(hook => hook.eventName === 'userPromptSubmit' ? hooks[0] : hook))).toBe('outdated');
  });
});

describe('OpenCode plugin bridge', () => {
  it('forwards the native session id and ignores known child sessions', () => {
    const plugin = opencodePluginJs();

    expect(plugin).toContain('{ session_id: sessionID }');
    expect(plugin).toContain('"chat.message": async ({ sessionID })');
    expect(plugin).toContain('event.type === "session.created" || event.type === "session.updated"');
    expect(plugin).toContain('if (info.parentID)');
    expect(plugin).not.toContain('await emit("session-start")');
  });
});

const USER_CONFIG = `# my kimi config
default_model = "k2"

[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = 'node ~/.kimi-code/hooks/my-guard.mjs'
timeout = 5

[theme]
name = "dark"
`;

describe('toml hooks installer (kimi)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-kimi-hooks-'));
    file = path.join(dir, 'config.toml');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports not-installed when the file is missing or has no termdock block', () => {
    expect(tomlHooksState(file, 'kimi', KIMI_HOOK_EVENTS)).toBe('not-installed');
    fs.writeFileSync(file, USER_CONFIG);
    expect(tomlHooksState(file, 'kimi', KIMI_HOOK_EVENTS)).toBe('not-installed');
  });

  it('installs every event and reaches installed state', () => {
    fs.writeFileSync(file, USER_CONFIG);
    tomlHooksInstall(file, 'kimi', KIMI_HOOK_EVENTS);
    expect(tomlHooksState(file, 'kimi', KIMI_HOOK_EVENTS)).toBe('installed');

    const text = fs.readFileSync(file, 'utf8');
    for (const [hookEvent, sentinel] of KIMI_HOOK_EVENTS) {
      expect(text).toContain(`event = "${hookEvent}"`);
      expect(text).toContain(`agent-hook kimi ${sentinel}'`);
    }
  });

  it('preserves the user config byte-for-byte above the appended blocks', () => {
    fs.writeFileSync(file, USER_CONFIG);
    tomlHooksInstall(file, 'kimi', KIMI_HOOK_EVENTS);
    const text = fs.readFileSync(file, 'utf8');
    expect(text.startsWith(USER_CONFIG + '\n')).toBe(true);
  });

  it('is idempotent: reinstalling rewrites marker blocks in place, never duplicates', () => {
    tomlHooksInstall(file, 'kimi', KIMI_HOOK_EVENTS);
    const once = fs.readFileSync(file, 'utf8');
    tomlHooksInstall(file, 'kimi', KIMI_HOOK_EVENTS);
    const twice = fs.readFileSync(file, 'utf8');
    expect(twice).toBe(once);
    expect(twice.match(/\[\[hooks\]\]/g)).toHaveLength(KIMI_HOOK_EVENTS.length);
  });

  it('reports outdated when a marker block carries a stale command', () => {
    tomlHooksInstall(file, 'kimi', KIMI_HOOK_EVENTS);
    const stale = fs.readFileSync(file, 'utf8').replace('agentHook.ts', 'old-agentHook.ts');
    // resolveHookScript() may point at .js in built installs — break whichever path exists
    const broken = stale === fs.readFileSync(file, 'utf8')
      ? stale.replace('agentHook.js', 'old-agentHook.js')
      : stale;
    fs.writeFileSync(file, broken);
    expect(tomlHooksState(file, 'kimi', KIMI_HOOK_EVENTS)).toBe('outdated');
    // Reinstalling heals it
    tomlHooksInstall(file, 'kimi', KIMI_HOOK_EVENTS);
    expect(tomlHooksState(file, 'kimi', KIMI_HOOK_EVENTS)).toBe('installed');
  });

  it('uninstall removes only termdock blocks and keeps user hooks', () => {
    fs.writeFileSync(file, USER_CONFIG);
    tomlHooksInstall(file, 'kimi', KIMI_HOOK_EVENTS);
    expect(tomlHooksUninstall(file, 'kimi')).toBe('Removed');
    expect(tomlHooksState(file, 'kimi', KIMI_HOOK_EVENTS)).toBe('not-installed');
    expect(fs.readFileSync(file, 'utf8')).toBe(USER_CONFIG);
  });

  it('uninstall is a no-op message when nothing is installed', () => {
    expect(tomlHooksUninstall(file, 'kimi')).toBe('Nothing installed; nothing to remove');
    fs.writeFileSync(file, USER_CONFIG);
    expect(tomlHooksUninstall(file, 'kimi')).toBe('No termdock hooks found; nothing to remove');
    expect(fs.readFileSync(file, 'utf8')).toBe(USER_CONFIG);
  });
});

describe('plugin JSON hook-map installer', () => {
  let dir: string;
  let file: string;
  const events: Array<[string, string, string | null, number?, string?]> = [
    ['BeforeTurn', 'prompt-submit', '^interactive$', 7, 'thinking'],
    ['AfterTurn', 'stop', null, 3, 'complete'],
  ];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-plugin-hooks-'));
    file = path.join(dir, 'hooks.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips matcher, timeout, status and detects configuration drift', () => {
    installPluginHooks('fake-agent', file, events);
    expect(pluginHooksState('fake-agent', file, events)).toBe('installed');
    const root = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(root.hooks.BeforeTurn[0].matcher).toBe('^interactive$');
    expect(root.hooks.BeforeTurn[0].hooks[0].timeout).toBe(7);
    expect(root.hooks.BeforeTurn[0].hooks[0].command).toContain('agent-hook fake-agent prompt-submit thinking');

    root.hooks.BeforeTurn[0].hooks[0].timeout = 8;
    fs.writeFileSync(file, JSON.stringify(root));
    expect(pluginHooksState('fake-agent', file, events)).toBe('outdated');
  });

  it('retains multiple mappings of one native event and preserves grouped user handlers and neighboring plugin names', () => {
    const user = { type: 'command', command: 'user-hook' };
    const neighbor = { type: 'command', command: 'node old.js agent-hook fake-agent-extra stop' };
    fs.writeFileSync(file, JSON.stringify({ hooks: { BeforeTool: [{ matcher: 'keep', hooks: [
      user, neighbor, { type: 'command', command: 'node old.js agent-hook fake-agent stop' },
    ] }] } }));
    const mappings: Array<[string, string, string | null, number?, string?]> = [
      ['BeforeTool', 'question-asked', '^Ask$', 2, 'question'],
      ['BeforeTool', 'prompt-submit', '^Run$', 4, 'thinking'],
    ];
    installPluginHooks('fake-agent', file, mappings);
    const installed = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(installed).hooks.BeforeTool).toHaveLength(3);
    expect(JSON.parse(installed).hooks.BeforeTool[0]).toEqual({ matcher: 'keep', hooks: [user, neighbor] });
    expect(pluginHooksState('fake-agent', file, mappings)).toBe('installed');
    installPluginHooks('fake-agent', file, mappings);
    expect(fs.readFileSync(file, 'utf8')).toBe(installed);
  });
});
