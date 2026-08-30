import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadSettingsFile,
  loadSettingsFileAsync,
  normalizeNewSessionAgentSlug,
  saveSettingsFile,
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

describe('settings persistence', () => {
  it('defaults the running-session button to disabled and preserves an enabled preference', () => {
    const settingsFile = tempSettingsPath();

    const defaults = loadSettingsFile(settingsFile);
    expect(defaults.runningSessionButtonEnabled).toBe(false);

    defaults.runningSessionButtonEnabled = true;
    saveSettingsFile(defaults, settingsFile);
    expect(loadSettingsFile(settingsFile).runningSessionButtonEnabled).toBe(true);
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
