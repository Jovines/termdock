import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkPluginPackageUpdate,
  commitPreparedPlugin,
  normalizeGitPluginSource,
  preparePluginPackage,
} from './pluginPackages.js';
import { loadPlugins, removePlugin } from './plugins.js';

const SLUG = 'package-agent-test';
const temporaryRoots: string[] = [];

async function fixture(overrides: Record<string, unknown> = {}): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'termdock-plugin-fixture-'));
  temporaryRoots.push(root);
  await fs.promises.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    version: 2,
    slug: SLUG,
    displayName: 'Package Agent',
    aliases: [SLUG],
    accentColor: '#4385BE',
    ...overrides,
  }), 'utf8');
  await fs.promises.writeFile(path.join(root, 'helper.js'), 'console.log("fixture")\n', 'utf8');
  return root;
}

afterEach(async () => {
  try { removePlugin(SLUG); } catch { /* absent */ }
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe('plugin package sources', () => {
  it('accepts public HTTPS Git repository roots and rejects unsafe sources', () => {
    expect(normalizeGitPluginSource('https://github.com/example/agent-plugin')).toBe('https://github.com/example/agent-plugin');
    expect(normalizeGitPluginSource('git@github.com:example/agent-plugin.git')).toBe('git@github.com:example/agent-plugin.git');
    expect(normalizeGitPluginSource('https://localhost/example/agent-plugin')).toBe('https://localhost/example/agent-plugin');
    expect(normalizeGitPluginSource('https://github.com/example/agent-plugin?token=secret')).toBeNull();
    expect(normalizeGitPluginSource('https://git.corp:8443/team/subgroup/agent.git')).toBe('https://git.corp:8443/team/subgroup/agent.git');
    expect(normalizeGitPluginSource('ssh://git@git.corp:2222/team/agent.git')).toBe('ssh://git@git.corp:2222/team/agent.git');
    expect(normalizeGitPluginSource('git@corp-alias:agent.git')).toBe('git@corp-alias:agent.git');
    expect(normalizeGitPluginSource('http://10.0.0.2/scm/team/agent.git')).toBe('http://10.0.0.2/scm/team/agent.git');
    for (const source of ['ext::sh -c anything', 'file:///etc', '-u@host:repo', 'https://user:secret@host/repo', 'ssh://-option/repo', 'https://host/repo%0aevil']) {
      expect(normalizeGitPluginSource(source)).toBeNull();
    }
  });

  it('installs and atomically updates a complete local package', async () => {
    const root = await fixture();
    const prepared = await preparePluginPackage(root);
    await commitPreparedPlugin(prepared);

    let installed = loadPlugins().plugins.find((plugin) => plugin.manifest.slug === SLUG)!;
    expect(installed.source?.type).toBe('local');
    expect(installed.source?.source).toBe(root);
    expect(fs.existsSync(path.join(installed.dir, 'helper.js'))).toBe(true);

    await fs.promises.writeFile(path.join(root, 'helper.js'), 'console.log("updated")\n', 'utf8');
    const check = await checkPluginPackageUpdate(installed);
    expect(check.updateAvailable).toBe(true);

    const replacement = await preparePluginPackage(root, SLUG);
    await commitPreparedPlugin(replacement, true);
    installed = loadPlugins().plugins.find((plugin) => plugin.manifest.slug === SLUG)!;
    expect(installed.source?.revision).toBe(check.latestRevision);
    expect(await fs.promises.readFile(path.join(installed.dir, 'helper.js'), 'utf8')).toContain('updated');
  });

  it('rejects package symlinks and active SVG content', async () => {
    const linked = await fixture();
    await fs.promises.symlink('/tmp', path.join(linked, 'escape'));
    await expect(preparePluginPackage(linked)).rejects.toThrow('symbolic links');

    const unsafe = await fixture();
    await fs.promises.writeFile(path.join(unsafe, 'icon.svg'), '<svg><script>alert(1)</script></svg>', 'utf8');
    await expect(preparePluginPackage(unsafe)).rejects.toThrow('unsafe active content');

    const tracking = await fixture();
    await fs.promises.writeFile(path.join(tracking, 'icon.svg'), '<svg><image href="https://tracker.invalid/pixel"/></svg>', 'utf8');
    await expect(preparePluginPackage(tracking)).rejects.toThrow('unsafe active content');
  });
});
