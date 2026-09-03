import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadSettingsFile,
  loadSettingsFileAsync,
  normalizeFileSortModes,
  normalizeNewSessionAgentSlug,
  normalizePinnedExplorerRoots,
  saveSettingsFile,
  watchPinnedExplorerRootsSetting,
} from './settings.js';

const tempDirs: string[] = [];

function tempSettingsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-settings-test-'));
  tempDirs.push(dir);
  return path.join(dir, 'settings.json');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('normalizeNewSessionAgentSlug', () => {
  it('normalizes a valid persisted agent slug', () => {
    expect(normalizeNewSessionAgentSlug('  Claude-Code  ')).toBe('claude-code');
  });

  it('rejects invalid or absent values', () => {
    expect(normalizeNewSessionAgentSlug(null)).toBeNull();
    expect(normalizeNewSessionAgentSlug('../codex')).toBeNull();
    expect(normalizeNewSessionAgentSlug('')).toBeNull();
  });
});

describe('normalizePinnedExplorerRoots', () => {
  it('keeps bounded absolute file and directory pins grouped by project root', () => {
    expect(normalizePinnedExplorerRoots({
      '/workspace/app': [
        { path: '/workspace/app/src', kind: 'directory' },
        { path: '/workspace/app/README.md', kind: 'file' },
        { path: '/workspace/app/src', kind: 'directory' },
        { path: 'relative.txt', kind: 'file' },
      ],
      relative: [{ path: '/tmp/ignored', kind: 'directory' }],
    })).toEqual({
      '/workspace/app': [
        { path: '/workspace/app/src', kind: 'directory' },
        { path: '/workspace/app/README.md', kind: 'file' },
      ],
    });
  });
});

describe('normalizeFileSortModes', () => {
  it('keeps bounded absolute paths using the supported non-default mode', () => {
    expect(normalizeFileSortModes({
      '/workspace/logs': 'modified',
      '/workspace/src': 'name',
      relative: 'modified',
      'C:\\projects\\logs': 'modified',
    })).toEqual({
      '/workspace/logs': 'modified',
      'C:\\projects\\logs': 'modified',
    });
  });
});

describe('settings persistence', () => {
  it('defaults the running-session button to disabled and preserves an enabled preference', () => {
    const settingsFile = tempSettingsPath();

    const defaults = loadSettingsFile(settingsFile);
    expect(defaults.runningSessionButtonEnabled).toBe(false);

    defaults.runningSessionButtonEnabled = true;
    saveSettingsFile(defaults, settingsFile);
    expect(loadSettingsFile(settingsFile).runningSessionButtonEnabled).toBe(true);
  });

  it('persists per-directory explorer sort preferences', () => {
    const settingsFile = tempSettingsPath();
    const settings = loadSettingsFile(settingsFile);
    expect(settings.fileSortModes).toEqual({});

    settings.fileSortModes = { '/workspace/logs': 'modified' };
    saveSettingsFile(settings, settingsFile);

    expect(loadSettingsFile(settingsFile).fileSortModes).toEqual({ '/workspace/logs': 'modified' });
  });

  it('persists explorer pins for sharing between clients', () => {
    const settingsFile = tempSettingsPath();
    const settings = loadSettingsFile(settingsFile);
    settings.pinnedExplorerRoots = {
      '/workspace/app': [{ path: '/workspace/app/docs', kind: 'directory' }],
    };
    saveSettingsFile(settings, settingsFile);

    expect(loadSettingsFile(settingsFile).pinnedExplorerRoots).toEqual(settings.pinnedExplorerRoots);
  });

  it('observes explorer pin writes made through the shared settings file', async () => {
    const settingsFile = tempSettingsPath();
    loadSettingsFile(settingsFile);
    let stopWatching = () => undefined;
    const observed = new Promise<Record<string, Array<{ path: string; kind: 'directory' }>>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('settings watcher did not observe pin update')), 2_000);
      stopWatching = watchPinnedExplorerRootsSetting((roots) => {
        clearTimeout(timeout);
        resolve(roots as Record<string, Array<{ path: string; kind: 'directory' }>>);
      }, settingsFile);
    });
    const settings = loadSettingsFile(settingsFile);
    settings.pinnedExplorerRoots = {
      '/workspace/app': [{ path: '/workspace/app/docs', kind: 'directory' }],
    };
    saveSettingsFile(settings, settingsFile);

    await expect(observed).resolves.toEqual(settings.pinnedExplorerRoots);
    stopWatching();
  });

  it('preserves fields introduced by newer binaries', () => {
    const settingsFile = tempSettingsPath();
    fs.writeFileSync(settingsFile, JSON.stringify({
      version: 1,
      autoRenameAgents: ['codex'],
      futureSetting: { enabled: true },
    }));

    const loaded = loadSettingsFile(settingsFile);

    expect(loaded.autoRenameAgents).toEqual(['codex']);
    expect(loaded.futureSetting).toEqual({ enabled: true });
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8')).futureSetting).toEqual({ enabled: true });
  });

  it('atomically replaces settings and keeps the previous valid document as backup', () => {
    const settingsFile = tempSettingsPath();
    fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, autoRenameAgents: ['codex'] }));
    const next = loadSettingsFile(settingsFile);
    next.preventSleep = true;

    saveSettingsFile(next, settingsFile);

    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8')).preventSleep).toBe(true);
    expect(JSON.parse(fs.readFileSync(`${settingsFile}.bak`, 'utf-8')).preventSleep).toBe(false);
    expect(fs.readdirSync(path.dirname(settingsFile)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('recovers a malformed primary file from the last valid backup', async () => {
    const settingsFile = tempSettingsPath();
    const backupFile = `${settingsFile}.bak`;
    fs.writeFileSync(settingsFile, '{"autoRenameAgents":');
    fs.writeFileSync(backupFile, JSON.stringify({ version: 1, autoRenameAgents: ['codex'] }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const recovered = await loadSettingsFileAsync(settingsFile, backupFile);

    expect(recovered.autoRenameAgents).toEqual(['codex']);
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8')).autoRenameAgents).toEqual(['codex']);
  });

  it('never overwrites malformed settings when no valid backup exists', () => {
    const settingsFile = tempSettingsPath();
    const malformed = '{"autoRenameAgents":';
    fs.writeFileSync(settingsFile, malformed);

    expect(() => loadSettingsFile(settingsFile)).toThrow(/Refusing to overwrite malformed settings/);
    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(malformed);
  });
});
