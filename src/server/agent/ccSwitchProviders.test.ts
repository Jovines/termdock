/**
 * Tests for the per-instance cc-switch provider override module.
 *
 * The SQL layer is exercised against a real temporary SQLite database via the
 * sqlite3 CLI (skipped automatically when sqlite3 is unavailable), so the
 * exact queries used in production stay covered.
 *
 * @author chaoruitao@bytedance.com by Trae
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildClaudeSettingsJson,
  buildCodexConfigToml,
  shellQuote,
} from './ccSwitchArtifacts.js';
import {
  cleanupCcSwitchArtifacts,
  isSafeProviderId,
  listCcSwitchProviders,
  prepareCcSwitchLaunch,
  resetCcSwitchStateForTests,
  sweepCcSwitchArtifacts,
} from './ccSwitchProviders.js';

const execFileAsync = promisify(execFile);

let sqliteAvailable = false;
let tmpDir = '';
let dbPath = '';
let artifactsRoot = '';
let codexHome = '';

const CLAUDE_PROVIDER = JSON.stringify({
  env: {
    ANTHROPIC_AUTH_TOKEN: 'tok-kimi',
    ANTHROPIC_BASE_URL: 'https://api.kimi.example/',
    ANTHROPIC_MODEL: 'kimi-for-coding',
  },
  model: 'fable',
  permissions: { allow: ['Bash(ls:*)'] },
  statusLine: { type: 'command', command: '/tmp/statusline' },
});

const CLAUDE_COMMON = JSON.stringify({
  env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '' },
  permissions: { defaultMode: 'bypassPermissions' },
});

const CODEX_PROVIDER = JSON.stringify({
  auth: { OPENAI_API_KEY: 'sk-codex-provider' },
  config: 'model_provider = "p1"\n\n[model_providers.p1]\nbase_url = "https://api.example/v1"\nwire_api = "responses"\n\n[projects."/Users/example"]\ntrust_level = "trusted"\n',
});

const CODEX_COMMON = '[projects."/Users/example"]\ntrust_level = "trusted"\n';

async function runSql(sql: string): Promise<void> {
  await execFileAsync('sqlite3', [dbPath, sql]);
}

beforeAll(async () => {
  try {
    await execFileAsync('sqlite3', ['--version']);
    sqliteAvailable = true;
  } catch {
    sqliteAvailable = false;
  }
});

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cc-switch-test-'));
  dbPath = path.join(tmpDir, 'cc-switch.db');
  artifactsRoot = path.join(tmpDir, 'provider-overrides');
  codexHome = path.join(tmpDir, 'global-codex');
  resetCcSwitchStateForTests({ dbPath, artifactsRoot, codexHome });

  if (!sqliteAvailable) return;
  await runSql(
    'CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, category TEXT, is_current INTEGER, sort_index INTEGER);'
    + 'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);',
  );
  await runSql(
    `INSERT INTO providers VALUES ('p-kimi', 'claude', 'Kimi For Coding', '${CLAUDE_PROVIDER.replace(/'/g, "''")}', 'cn_official', 1, 0);`,
  );
  await runSql(
    `INSERT INTO providers VALUES ('p-official', 'claude', 'Claude Official', '{"env":{}}', 'official', 0, 1);`,
  );
  await runSql(
    `INSERT INTO providers VALUES ('p-codex', 'codex', 'Relay Codex', '${CODEX_PROVIDER.replace(/'/g, "''")}', 'third_party', 1, 0);`,
  );
  await runSql(
    `INSERT INTO providers VALUES ('p-codex-empty', 'codex', 'Empty Codex', '{"auth":{},"config":""}', NULL, 0, 1);`,
  );
  await runSql(`INSERT INTO settings VALUES ('common_config_claude', '${CLAUDE_COMMON.replace(/'/g, "''")}');`);
  await runSql(`INSERT INTO settings VALUES ('common_config_codex', '${CODEX_COMMON.replace(/'/g, "''")}');`);

  // Global codex home fixture: credentials/config to inherit, entries to
  // share, and runtime state that must stay unlinked.
  await fs.promises.mkdir(path.join(codexHome, 'sessions'), { recursive: true });
  await fs.promises.writeFile(path.join(codexHome, 'auth.json'), '{"OPENAI_API_KEY":"sk-global"}\n');
  await fs.promises.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-5"\n\n[features]\nmemories = true\n');
  await fs.promises.writeFile(path.join(codexHome, 'hooks.json'), '{"hooks":{}}\n');
  await fs.promises.writeFile(path.join(codexHome, 'history.jsonl'), '{}\n');
  await fs.promises.writeFile(path.join(codexHome, 'state_5.sqlite'), 'sqlite');
});

afterEach(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

describe('buildClaudeSettingsJson', () => {
  it('clears every routing key before layering provider env', () => {
    const doc = buildClaudeSettingsJson({ ANTHROPIC_BASE_URL: 'https://x.example' }, {});
    expect(doc.env.ANTHROPIC_BASE_URL).toBe('https://x.example');
    for (const key of [
      'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_VERTEX_REGION',
    ]) {
      expect(doc.env[key]).toBe('');
    }
  });

  it('lets provider env override the common config env and keeps empty strings', () => {
    const doc = buildClaudeSettingsJson(
      { ANTHROPIC_MODEL: '' },
      { ANTHROPIC_MODEL: 'common-model', EXTRA: '1' },
    );
    expect(doc.env.ANTHROPIC_MODEL).toBe('');
    expect(doc.env.EXTRA).toBe('1');
  });

  it('passes the model tier through only when present', () => {
    expect(buildClaudeSettingsJson({}, {}, 'fable').model).toBe('fable');
    expect(buildClaudeSettingsJson({}, {}).model).toBeUndefined();
  });
});

describe('buildCodexConfigToml', () => {
  it('skips common sections whose table header already exists in base', () => {
    const merged = buildCodexConfigToml(JSON.parse(CODEX_PROVIDER).config as string, CODEX_COMMON);
    expect(merged.match(/\[projects\."\/Users\/example"\]/g)).toHaveLength(1);
  });

  it('appends [features] hooks = true when missing', () => {
    const merged = buildCodexConfigToml('model = "gpt-5"\n', '');
    expect(merged).toContain('[features]\nhooks = true');
  });

  it('inserts hooks = true into an existing [features] section', () => {
    const merged = buildCodexConfigToml('model = "gpt-5"\n\n[features]\nmemories = true\n', '');
    expect(merged).toMatch(/\[features\]\nhooks = true\nmemories = true/);
  });

  it('leaves an explicit hooks setting untouched', () => {
    const merged = buildCodexConfigToml('[features]\nhooks = false\n', '');
    expect(merged).toContain('hooks = false');
    expect(merged).not.toContain('hooks = true');
  });

  it('handles an empty base', () => {
    expect(buildCodexConfigToml('', '')).toBe('[features]\nhooks = true\n');
  });

  it('drops bare keys from common (they would bind to the wrong table)', () => {
    const merged = buildCodexConfigToml('model = "gpt-5"\n', 'approval_policy = "never"\n');
    expect(merged).not.toContain('approval_policy');
  });
});

describe('isSafeProviderId / shellQuote', () => {
  it('accepts uuid-like and slug ids, rejects injection', () => {
    expect(isSafeProviderId('8628dc8a-a305-4a5f-b9dd-2f562ffcef2b')).toBe(true);
    expect(isSafeProviderId('claude-official')).toBe(true);
    expect(isSafeProviderId("x'; DROP TABLE providers;--")).toBe(false);
    expect(isSafeProviderId('../etc/passwd')).toBe(false);
    expect(isSafeProviderId('')).toBe(false);
  });

  it('shell-quotes single quotes', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(shellQuote('/plain/path')).toBe(`'/plain/path'`);
  });
});

describe('prepareCcSwitchLaunch (sqlite integration)', () => {
  it('lists providers without leaking settings_config', async (ctx) => {
    if (!sqliteAvailable) return ctx.skip();
    const result = await listCcSwitchProviders('claude');
    expect(result.available).toBe(true);
    expect(result.providers.map((p) => p.id).sort()).toEqual(['p-kimi', 'p-official']);
    const kimi = result.providers.find((p) => p.id === 'p-kimi');
    expect(kimi?.isCurrent).toBe(true);
    expect(JSON.stringify(result.providers)).not.toContain('tok-kimi');
  });

  it('writes a claude override that isolates the provider per instance', async (ctx) => {
    if (!sqliteAvailable) return ctx.skip();
    const result = await prepareCcSwitchLaunch({ sessionId: 'sess12345', app: 'claude', providerId: 'p-kimi' });
    const file = path.join(artifactsRoot, 'claude-sess12345.json');
    expect(result.command).toBe(`claude --settings '${file}'`);
    expect(result.providerName).toBe('Kimi For Coding');

    const stat = await fs.promises.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
    const doc = JSON.parse(await fs.promises.readFile(file, 'utf-8'));
    expect(doc.env.ANTHROPIC_AUTH_TOKEN).toBe('tok-kimi');
    expect(doc.env.ANTHROPIC_BASE_URL).toBe('https://api.kimi.example/');
    expect(doc.env.ANTHROPIC_API_KEY).toBe('');
    expect(doc.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('');
    expect(doc.model).toBe('fable');
    expect(doc.permissions).toBeUndefined();
    expect(doc.statusLine).toBeUndefined();

    // Idempotent: a retry rewrites the same artifact without error.
    await expect(prepareCcSwitchLaunch({ sessionId: 'sess12345', app: 'claude', providerId: 'p-kimi' })).resolves.toBeDefined();
  });

  it('builds an isolated codex home with shared state symlinks', async (ctx) => {
    if (!sqliteAvailable) return ctx.skip();
    const result = await prepareCcSwitchLaunch({ sessionId: 'csess1', app: 'codex', providerId: 'p-codex' });
    const home = path.join(artifactsRoot, 'codex-home-csess1');
    expect(result.command).toBe(`CODEX_HOME='${home}' codex`);

    expect(JSON.parse(await fs.promises.readFile(path.join(home, 'auth.json'), 'utf-8')).OPENAI_API_KEY)
      .toBe('sk-codex-provider');

    const config = await fs.promises.readFile(path.join(home, 'config.toml'), 'utf-8');
    expect(config).toContain('model_provider = "p1"');
    expect(config.match(/\[projects\."\/Users\/example"\]/g)).toHaveLength(1);
    expect(config).toContain('[features]\nhooks = true');

    expect((await fs.promises.lstat(path.join(home, 'sessions'))).isSymbolicLink()).toBe(true);
    expect((await fs.promises.lstat(path.join(home, 'hooks.json'))).isSymbolicLink()).toBe(true);
    expect((await fs.promises.lstat(path.join(home, 'history.jsonl'))).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(home, 'state_5.sqlite'))).toBe(false);
  });

  it('falls back to the global codex home for empty provider snapshots', async (ctx) => {
    if (!sqliteAvailable) return ctx.skip();
    await prepareCcSwitchLaunch({ sessionId: 'csess2', app: 'codex', providerId: 'p-codex-empty' });
    const home = path.join(artifactsRoot, 'codex-home-csess2');
    expect(JSON.parse(await fs.promises.readFile(path.join(home, 'auth.json'), 'utf-8')).OPENAI_API_KEY)
      .toBe('sk-global');
    const config = await fs.promises.readFile(path.join(home, 'config.toml'), 'utf-8');
    expect(config).toContain('model = "gpt-5"');
    expect(config).toMatch(/\[features\]\nhooks = true\nmemories = true/);
  });

  it('rejects unknown providers and unsafe ids without writing anything', async (ctx) => {
    if (!sqliteAvailable) return ctx.skip();
    await expect(prepareCcSwitchLaunch({ sessionId: 'sess9', app: 'claude', providerId: 'missing' })).rejects.toThrow('not found');
    await expect(prepareCcSwitchLaunch({ sessionId: 'sess9', app: 'claude', providerId: "x'; DROP TABLE providers;--" })).rejects.toThrow('Invalid provider id');
    expect(fs.existsSync(artifactsRoot)).toBe(false);
  });
});

describe('cleanupCcSwitchArtifacts / sweepCcSwitchArtifacts', () => {
  it('removes both artifact kinds for a session', async (ctx) => {
    if (!sqliteAvailable) return ctx.skip();
    await prepareCcSwitchLaunch({ sessionId: 'gone1', app: 'claude', providerId: 'p-kimi' });
    await prepareCcSwitchLaunch({ sessionId: 'gone1', app: 'codex', providerId: 'p-codex' });
    expect(fs.existsSync(path.join(artifactsRoot, 'claude-gone1.json'))).toBe(true);
    await cleanupCcSwitchArtifacts('gone1');
    expect(fs.existsSync(path.join(artifactsRoot, 'claude-gone1.json'))).toBe(false);
    expect(fs.existsSync(path.join(artifactsRoot, 'codex-home-gone1'))).toBe(false);
  });

  it('sweeps only stale artifacts of dead sessions', async () => {
    await fs.promises.mkdir(artifactsRoot, { recursive: true });
    const stale = path.join(artifactsRoot, 'claude-dead1.json');
    const fresh = path.join(artifactsRoot, 'claude-dead2.json');
    const alive = path.join(artifactsRoot, 'claude-live1.json');
    await Promise.all([stale, fresh, alive].map((file) => fs.promises.writeFile(file, '{}')));
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000);
    await fs.promises.utimes(stale, twoDaysAgo, twoDaysAgo);

    await sweepCcSwitchArtifacts(new Set(['live1']));
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(alive)).toBe(true);
  });
});
