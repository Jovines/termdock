import { describe, expect, it, afterEach } from 'vitest';
import { loadPlugins, savePlugin, removePlugin, type AgentPluginManifest, type LoadedPlugin } from './plugins.js';
import {
  agentBySlug,
  buildResumeCommand,
  clearPluginAgents,
  detectAgentFromArgv,
  registerPluginAgents,
} from './registry.js';

const TEST_PLUGIN: AgentPluginManifest = {
  version: 1,
  slug: 'test-agent',
  displayName: 'Test Agent',
  aliases: ['test-agent', 'tai'],
  accentColor: '#FF6600',
  hooks: {
    target: '~/.test-agent/hooks.json',
    events: [
      { hook: 'SessionStart', event: 'session-start' },
      { hook: 'Stop', event: 'stop' },
    ],
  },
  resume: {
    command: 'test-agent --resume {sessionId}',
    staleFlags: ['--resume', '-r'],
  },
};

function makePlugin(manifest: AgentPluginManifest): LoadedPlugin {
  return {
    manifest,
    dir: '/tmp/test',
    iconPath: null,
    iconMtime: 0,
  };
}

describe('plugin validation', () => {
  it('accepts a valid manifest', () => {
    const plugins = loadPlugins();
    // Built-in registry should not be affected
    expect(Array.isArray(plugins.plugins)).toBe(true);
  });
});

describe('registerPluginAgents', () => {
  afterEach(() => {
    clearPluginAgents();
  });

  it('registers plugin agents in the lookup maps', () => {
    const plugin = makePlugin(TEST_PLUGIN);
    const result = registerPluginAgents([plugin]);
    expect(result.registered).toBe(1);
    expect(result.skipped).toHaveLength(0);

    const agent = agentBySlug('test-agent');
    expect(agent).not.toBeNull();
    expect(agent!.displayName).toBe('Test Agent');
    expect(agent!.accentColor).toBe('#FF6600');
    expect(agent!.isPlugin).toBe(true);

    // Alias works for detection, not slug lookup
    expect(detectAgentFromArgv(['tai'])?.slug).toBe('test-agent');
  });

  it('detects plugin agents from argv', () => {
    const plugin = makePlugin(TEST_PLUGIN);
    registerPluginAgents([plugin]);

    const detected = detectAgentFromArgv(['test-agent', '--flag']);
    expect(detected?.slug).toBe('test-agent');
    expect(detected?.displayName).toBe('Test Agent');

    // Alias detection
    expect(detectAgentFromArgv(['tai'])?.slug).toBe('test-agent');
  });

  it('skips plugins whose slug conflicts with built-in agents', () => {
    const plugin = makePlugin({ ...TEST_PLUGIN, slug: 'claude', aliases: ['claude'] });
    const result = registerPluginAgents([plugin]);
    expect(result.registered).toBe(0);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('skips plugins whose alias conflicts with built-in agents', () => {
    const plugin = makePlugin({ ...TEST_PLUGIN, slug: 'my-claude', aliases: ['my-ai', 'codex'] });
    const result = registerPluginAgents([plugin]);
    expect(result.registered).toBe(0);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.skipped[0]).toContain('codex');
  });

  it('clears plugin agents without affecting built-ins', () => {
    const plugin = makePlugin(TEST_PLUGIN);
    registerPluginAgents([plugin]);
    expect(agentBySlug('test-agent')).not.toBeNull();
    expect(agentBySlug('claude')).not.toBeNull();

    clearPluginAgents();
    expect(agentBySlug('test-agent')).toBeNull();
    expect(agentBySlug('claude')).not.toBeNull();
  });
});

describe('plugin resume', () => {
  afterEach(() => {
    clearPluginAgents();
  });

  it('builds resume command for plugin agents', () => {
    const plugin = makePlugin(TEST_PLUGIN);
    registerPluginAgents([plugin]);

    const agent = agentBySlug('test-agent')!;
    const cmd = buildResumeCommand(agent, 'abc-123', null);
    expect(cmd).toBe('test-agent --resume abc-123');
  });

  it('returns null for unsafe session ids', () => {
    const plugin = makePlugin(TEST_PLUGIN);
    registerPluginAgents([plugin]);
    const agent = agentBySlug('test-agent')!;
    expect(buildResumeCommand(agent, 'abc; rm -rf /', null)).toBeNull();
    expect(buildResumeCommand(agent, '', null)).toBeNull();
  });

  it('returns null for plugin without resume config', () => {
    const noResume: AgentPluginManifest = {
      version: 1,
      slug: 'no-resume-agent',
      displayName: 'No Resume',
      aliases: ['nra'],
      accentColor: '#000000',
    };
    const plugin = makePlugin(noResume);
    registerPluginAgents([plugin]);
    const agent = agentBySlug('no-resume-agent')!;
    expect(buildResumeCommand(agent, 'abc', null)).toBeNull();
  });
});

describe('plugin CRUD', () => {
  afterEach(() => {
    try { removePlugin(TEST_PLUGIN.slug); } catch { /* ok */ }
  });

  it('savePlugin creates a directory and manifest', () => {
    savePlugin(TEST_PLUGIN);
    const { plugins } = loadPlugins();
    const found = plugins.find((p) => p.manifest.slug === TEST_PLUGIN.slug);
    expect(found).toBeDefined();
    expect(found!.manifest.displayName).toBe('Test Agent');
  });

  it('removePlugin deletes the plugin', () => {
    savePlugin(TEST_PLUGIN);
    removePlugin(TEST_PLUGIN.slug);
    const { plugins } = loadPlugins();
    expect(plugins.find((p) => p.manifest.slug === TEST_PLUGIN.slug)).toBeUndefined();
  });

  it('removePlugin throws for non-existent plugin', () => {
    expect(() => removePlugin('nonexistent-plugin')).toThrow();
  });
});
