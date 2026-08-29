import { describe, expect, it, afterEach } from 'vitest';
import { loadPlugins, savePlugin, removePlugin, validateManifest, type AgentPluginManifest, type LoadedPlugin } from './plugins.js';
import {
  agentBySlug,
  buildResumeCommand,
  clearPluginAgents,
  detectAgentFromArgv,
  listAgents,
  registerPluginAgents,
} from './registry.js';
import { applyAgentEvent, buildHookSequence, defaultAgentSessionState, parseAgentEvent } from './session.js';

const TEST_PLUGIN: AgentPluginManifest = {
  version: 2,
  slug: 'test-agent',
  displayName: 'Test Agent',
  aliases: ['test-agent', 'tai'],
  capabilities: ['代码审查', 'testing'],
  accentColor: '#FF6600',
  statuses: [
    { id: 'thinking', phase: 'working', label: 'Thinking', indicator: 'spinner', tone: 'info' },
    { id: 'approval', phase: 'waiting', label: 'Needs approval', indicator: 'question', tone: 'warning' },
  ],
  hooks: {
    target: '~/.test-agent/hooks.json',
    events: [
      { hook: 'SessionStart', event: 'session-start' },
      { hook: 'Stop', event: 'stop', status: 'approval' },
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
    source: null,
  };
}

describe('plugin validation', () => {
  it('accepts a valid manifest', () => {
    const plugins = loadPlugins();
    // Built-in registry should not be affected
    expect(Array.isArray(plugins.plugins)).toBe(true);
  });

  it('validates dynamic statuses and hook references', () => {
    expect(validateManifest(TEST_PLUGIN, '/tmp/test')).toHaveProperty('manifest');
    const invalid = validateManifest({
      ...TEST_PLUGIN,
      hooks: { ...TEST_PLUGIN.hooks, events: [{ hook: 'Stop', event: 'stop', status: 'missing' }] },
    }, '/tmp/test');
    expect(invalid).toHaveProperty('error');
  });

  it('validates collaboration capabilities and keeps them in the Agent registry', () => {
    expect(validateManifest({ ...TEST_PLUGIN, capabilities: ['review', 'review'] }, '/tmp/test')).toMatchObject({
      manifest: { capabilities: ['review'] },
    });
    expect(validateManifest({ ...TEST_PLUGIN, capabilities: ['review', 'bad/slash'] }, '/tmp/test')).toHaveProperty('error');
    clearPluginAgents();
    registerPluginAgents([makePlugin(TEST_PLUGIN)]);
    expect(agentBySlug(TEST_PLUGIN.slug)?.capabilities).toEqual(TEST_PLUGIN.capabilities);
    clearPluginAgents();
  });

  it('confines plugin hook targets to non-symlinked JSON paths under home', () => {
    expect(validateManifest({
      ...TEST_PLUGIN,
      hooks: { ...TEST_PLUGIN.hooks, target: '/tmp/agent-hooks.json' },
    }, '/tmp/test')).toHaveProperty('error');
    expect(validateManifest({
      ...TEST_PLUGIN,
      hooks: { ...TEST_PLUGIN.hooks, target: '~/.test-agent/hooks.toml' },
    }, '/tmp/test')).toHaveProperty('error');
  });

  it('validates an injectable title provider and requires a prompt placeholder', () => {
    const provider = {
      ...TEST_PLUGIN,
      titleNamer: {
        command: 'test-agent',
        args: ['title', '--prompt', '{prompt}', '--model={model}'],
        models: { command: 'test-agent', args: ['models', '--json'] },
      },
    };
    expect(validateManifest(provider, '/tmp/test')).toHaveProperty('manifest');
    expect(validateManifest({
      ...provider,
      titleNamer: { ...provider.titleNamer, args: ['title'] },
    }, '/tmp/test')).toHaveProperty('error');

    const atomicModelArgs = {
      ...TEST_PLUGIN,
      titleNamer: {
        command: 'test-agent',
        modelArgs: ['-c', 'model="{model}"'],
        args: ['-p', '{prompt}'],
      },
    };
    expect(validateManifest(atomicModelArgs, '/tmp/test')).toHaveProperty('manifest');
    expect(validateManifest({
      ...atomicModelArgs,
      titleNamer: { ...atomicModelArgs.titleNamer, args: ['-p', '{prompt}', '{model}'] },
    }, '/tmp/test')).toHaveProperty('error');
  });

  it('returns an AI-ready migration diagnostic for manifest v1', () => {
    const result = validateManifest({ ...TEST_PLUGIN, version: 1 }, '/tmp/test');
    expect(result).toHaveProperty('error');
    if (!('error' in result)) throw new Error('expected validation error');
    expect(result.error.code).toBe('AGENT_PLUGIN_MANIFEST_V1_UNSUPPORTED');
    expect(result.error.migration?.guideCommand).toBe('td agent-plugin --json');
    expect(result.error.migration?.aiPrompt).toContain('Return only the corrected manifest JSON');
    expect(result.error.errors.join(' ')).toContain('manifest v1 is no longer supported');
  });

  it('rejects shell syntax in aliases and resume templates', () => {
    expect(validateManifest({
      ...TEST_PLUGIN,
      resume: { command: 'test-agent --resume {sessionId}; touch /tmp/pwned' },
    }, '/tmp/test')).toHaveProperty('error');
    expect(validateManifest({
      ...TEST_PLUGIN,
      aliases: ['test-agent;evil'],
    }, '/tmp/test')).toHaveProperty('error');
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
    expect(agent!.icon).toBeNull();
    expect(agent!.isPlugin).toBe(true);
    expect(agent!.statuses?.map((status) => status.id)).toEqual(['thinking', 'approval']);
    expect(listAgents().some((entry) => entry.slug === 'test-agent')).toBe(true);

    // Alias works for detection, not slug lookup
    expect(detectAgentFromArgv(['tai'])?.slug).toBe('test-agent');
  });

  it('publishes the plugin icon key only when icon.svg exists', () => {
    registerPluginAgents([{ ...makePlugin(TEST_PLUGIN), iconPath: '/tmp/test/icon.svg', iconMtime: 123 }]);

    expect(agentBySlug('test-agent')).toMatchObject({
      icon: 'test-agent',
      iconVersion: 123,
    });
  });

  it('resolves a manifest status from the hook wire into the shared phase model', () => {
    registerPluginAgents([makePlugin(TEST_PLUGIN)]);
    const event = parseAgentEvent(
      buildHookSequence('test-agent', 'permission-request', '{"message":"Approve deploy"}', 'approval').slice(2, -1),
    );
    expect(event?.status?.label).toBe('Needs approval');
    const state = defaultAgentSessionState();
    applyAgentEvent(state, event!);
    expect(state.status).toBe('waiting');
    expect(state.presentation?.id).toBe('approval');
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
      version: 2,
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
