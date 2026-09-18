/**
 * Per-instance cc-switch provider overrides for Claude Code and Codex.
 *
 * cc-switch only supports app-level switching: it rewrites the live global
 * config files (~/.claude/settings.json, ~/.codex/auth.json + config.toml),
 * which would silently retarget every already-running instance. This module
 * never invokes that path. It reads provider definitions from cc-switch's
 * SQLite database (strictly read-only) and materializes them as per-session
 * launch artifacts under ~/.termdock/provider-overrides/ (built by
 * ccSwitchArtifacts.ts):
 *
 *   - claude: a settings JSON passed via `claude --settings <file>` (a
 *     command-line settings source outranks user settings, scoped to that one
 *     process). Routing keys absent from the provider snapshot are explicitly
 *     cleared with "" (the same convention cc-switch itself uses) so values
 *     from the user's global settings.json cannot leak into the instance.
 *   - codex: an isolated CODEX_HOME directory carrying the provider's
 *     auth.json/config.toml, with a whitelist of state entries (sessions,
 *     history, hooks, skills…) symlinked back to the global ~/.codex so
 *     history, resume and termdock's agent hooks keep working.
 *
 * Nothing outside ~/.termdock/provider-overrides/ is ever written, and
 * provider secrets (settings_config) never leave the server.
 *
 * @author chaoruitao@bytedance.com by Trae
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  parseClaudeCommon,
  parseClaudeSnapshot,
  parseCodexSnapshot,
  shellQuote,
  writeClaudeOverride,
  writeCodexHome,
} from './ccSwitchArtifacts.js';

const execFileAsync = promisify(execFile);

export type CcSwitchApp = 'claude' | 'codex';

export interface CcSwitchProviderSummary {
  id: string;
  name: string;
  category: string | null;
  isCurrent: boolean;
}

export interface CcSwitchLaunchResult {
  command: string;
  providerName: string;
}

const SQLITE_TIMEOUT_MS = 5000;
const SQLITE_MAX_BUFFER = 8 * 1024 * 1024;
const AVAILABILITY_TTL_MS = 60_000;
const SWEEP_INTERVAL_MS = 6 * 3600_000;
const DEFAULT_SWEEP_MAX_AGE_MS = 24 * 3600_000;

let dbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
let artifactsRoot = path.join(os.homedir(), '.termdock', 'provider-overrides');
let codexHomeOverride: string | null = null;
let sqliteBinary: string | null = null;
let availabilityCache: { ok: boolean; checkedAt: number } | null = null;
let lastSweepAt = 0;

export function isSafeProviderId(id: string): boolean {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/**
 * Test hook: reset module caches and optionally redirect storage paths so
 * tests never touch the real cc-switch database or ~/.termdock.
 */
export function resetCcSwitchStateForTests(overrides?: {
  dbPath?: string;
  artifactsRoot?: string;
  codexHome?: string;
}): void {
  if (overrides?.dbPath) dbPath = overrides.dbPath;
  if (overrides?.artifactsRoot) artifactsRoot = overrides.artifactsRoot;
  if (overrides?.codexHome !== undefined) codexHomeOverride = overrides.codexHome;
  sqliteBinary = null;
  availabilityCache = null;
  lastSweepAt = 0;
}

function codexGlobalHome(): string {
  if (codexHomeOverride) return codexHomeOverride;
  const fromEnv = process.env.CODEX_HOME?.trim();
  return fromEnv || path.join(os.homedir(), '.codex');
}

async function probeSqliteBinary(): Promise<string | null> {
  for (const candidate of ['sqlite3', '/usr/bin/sqlite3']) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: SQLITE_TIMEOUT_MS });
      return candidate;
    } catch { /* try the next candidate */ }
  }
  return null;
}

export async function isCcSwitchAvailable(): Promise<boolean> {
  if (availabilityCache && Date.now() - availabilityCache.checkedAt < AVAILABILITY_TTL_MS) {
    return availabilityCache.ok;
  }
  let ok = false;
  try {
    await fs.promises.access(dbPath, fs.constants.R_OK);
    const binary = await probeSqliteBinary();
    if (binary) {
      sqliteBinary = binary;
      ok = true;
    }
  } catch {
    ok = false;
  }
  availabilityCache = { ok, checkedAt: Date.now() };
  return ok;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function runSqliteJson<T>(sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync(
    sqliteBinary ?? 'sqlite3',
    ['-readonly', '-json', dbPath, sql],
    { timeout: SQLITE_TIMEOUT_MS, maxBuffer: SQLITE_MAX_BUFFER },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed as T[] : [];
}

export async function listCcSwitchProviders(
  app: CcSwitchApp,
): Promise<{ available: boolean; providers: CcSwitchProviderSummary[] }> {
  if (!(await isCcSwitchAvailable())) return { available: false, providers: [] };
  // settings_config intentionally stays unselected: it carries provider
  // secrets and must never leave the server.
  interface Row { id: string; name: string; category: string | null; is_current: number | boolean }
  const rows = await runSqliteJson<Row>(
    `SELECT id, name, category, is_current FROM providers WHERE app_type=${sqlString(app)} ORDER BY sort_index ASC, name ASC`,
  );
  return {
    available: true,
    providers: rows
      .filter((row) => isSafeProviderId(row.id) && typeof row.name === 'string')
      .map((row) => ({
        id: row.id,
        name: row.name,
        category: typeof row.category === 'string' ? row.category : null,
        isCurrent: !!row.is_current,
      })),
  };
}

async function readCommonConfig(app: CcSwitchApp): Promise<string | null> {
  interface Row { value: string }
  const rows = await runSqliteJson<Row>(
    `SELECT value FROM settings WHERE key=${sqlString(`common_config_${app}`)} LIMIT 1`,
  );
  return typeof rows[0]?.value === 'string' ? rows[0].value : null;
}

export async function prepareCcSwitchLaunch(params: {
  sessionId: string;
  app: CcSwitchApp;
  providerId: string;
}): Promise<CcSwitchLaunchResult> {
  const { sessionId, app, providerId } = params;
  if (!isSafeProviderId(sessionId)) throw new Error('Invalid session id');
  if (!isSafeProviderId(providerId)) throw new Error('Invalid provider id');
  if (!(await isCcSwitchAvailable())) throw new Error('cc-switch is not installed');

  interface ProviderRow { name: string; settings_config: string }
  const rows = await runSqliteJson<ProviderRow>(
    `SELECT name, settings_config FROM providers WHERE app_type=${sqlString(app)} AND id=${sqlString(providerId)} LIMIT 1`,
  );
  const row = rows[0];
  if (!row) throw new Error(`cc-switch provider not found: ${providerId}`);

  const commonRaw = await readCommonConfig(app);
  if (app === 'claude') {
    const file = await writeClaudeOverride(artifactsRoot, sessionId, parseClaudeSnapshot(row.settings_config), parseClaudeCommon(commonRaw));
    return { command: `claude --settings ${shellQuote(file)}`, providerName: row.name };
  }
  const home = await writeCodexHome(artifactsRoot, codexGlobalHome(), sessionId, parseCodexSnapshot(row.settings_config), commonRaw ?? '');
  return { command: `CODEX_HOME=${shellQuote(home)} codex`, providerName: row.name };
}

export async function cleanupCcSwitchArtifacts(sessionId: string): Promise<void> {
  if (!isSafeProviderId(sessionId)) return;
  await Promise.all([
    fs.promises.rm(path.join(artifactsRoot, `claude-${sessionId}.json`), { force: true }).catch(() => undefined),
    fs.promises.rm(path.join(artifactsRoot, `codex-home-${sessionId}`), { force: true, recursive: true }).catch(() => undefined),
  ]);
}

/**
 * Best-effort orphan sweep: artifacts whose session is gone and that are older
 * than maxAgeMs. The age gate protects sessions whose pty-host has not yet
 * re-registered after a server restart. Throttled to run at most once per
 * SWEEP_INTERVAL_MS.
 */
export async function sweepCcSwitchArtifacts(
  aliveSessionIds: ReadonlySet<string>,
  maxAgeMs: number = DEFAULT_SWEEP_MAX_AGE_MS,
): Promise<void> {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(artifactsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = now - maxAgeMs;
  for (const entry of entries) {
    const match = /^(?:claude-([A-Za-z0-9_-]+)\.json|codex-home-([A-Za-z0-9_-]+))$/.exec(entry.name);
    const sessionId = match?.[1] ?? match?.[2];
    if (!sessionId || aliveSessionIds.has(sessionId)) continue;
    try {
      const target = path.join(artifactsRoot, entry.name);
      const stat = await fs.promises.stat(target);
      if (stat.mtimeMs >= cutoff) continue;
      await fs.promises.rm(target, { force: true, recursive: entry.isDirectory() });
    } catch { /* best-effort sweep */ }
  }
}
