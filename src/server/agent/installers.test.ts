import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KIMI_HOOK_EVENTS,
  installPluginHooks,
  pluginHooksState,
  tomlHooksInstall,
  tomlHooksState,
  tomlHooksUninstall,
} from './installers.js';

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
});
