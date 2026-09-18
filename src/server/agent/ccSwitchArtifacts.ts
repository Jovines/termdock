/**
 * Launch-artifact builders for per-instance cc-switch provider overrides.
 *
 * Pure builders/parsers plus the filesystem writers that materialize a
 * provider snapshot under ~/.termdock/provider-overrides/ (claude --settings
 * JSON, codex CODEX_HOME). All functions take their target paths as
 * parameters so no module state lives here; the service layer in
 * ccSwitchProviders.ts owns paths, caches and the SQLite reads.
 *
 * @author chaoruitao@bytedance.com by Trae
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * claude env keys that decide where a session talks to. Any key the chosen
 * provider does not set must be explicitly cleared, otherwise the value from
 * the user's global ~/.claude/settings.json merges in and silently re-routes
 * or re-authenticates the instance (e.g. an ANTHROPIC_API_KEY left over from
 * another provider would win over this provider's ANTHROPIC_AUTH_TOKEN).
 */
const CLAUDE_ROUTING_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_REGION',
] as const;

/**
 * ~/.codex entries shared into every per-instance CODEX_HOME. History,
 * resume data, hooks and skills stay unified; credentials and config are
 * deliberately NOT linked (they are what makes the instance distinct), and
 * neither are sqlite/log/tmp/ipc entries (app-server runtime state must stay
 * per-instance).
 */
const CODEX_HOME_SYMLINKS = [
  'sessions',
  'archived_sessions',
  'history.jsonl',
  'session_index.jsonl',
  'hooks.json',
  'skills',
  'rules',
  'prompts',
  'AGENTS.md',
  'keybindings.json',
  'models_cache.json',
  'version.json',
] as const;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildClaudeSettingsJson(
  providerEnv: Record<string, string>,
  commonEnv: Record<string, string>,
  model?: string,
): { env: Record<string, string>; model?: string } {
  const env: Record<string, string> = {};
  for (const key of CLAUDE_ROUTING_KEYS) env[key] = '';
  Object.assign(env, commonEnv, providerEnv);
  return model ? { env, model } : { env };
}

/**
 * Merge cc-switch's codex common config into a provider config. Sections of
 * `common` whose table header already exists in `base` are skipped: snapshots
 * frequently contain the same [projects.*] tables as the common config, and
 * appending them verbatim would produce duplicate-table TOML that codex
 * refuses to parse. Finally ensures [features] hooks = true so termdock's
 * agent hooks (symlinked hooks.json) actually fire.
 */
export function buildCodexConfigToml(base: string, common: string): string {
  const baseHeaders = new Set(
    base.split('\n').map((line) => line.trim()).filter((line) => /^\[.+\]$/.test(line)),
  );
  const chunks: string[] = [];
  let current: string[] | null = null;
  const flush = () => {
    if (current && current.length > 0) chunks.push(current.join('\n'));
    current = null;
  };
  for (const line of common.split('\n')) {
    if (/^\s*\[.+\]\s*$/.test(line)) {
      flush();
      current = baseHeaders.has(line.trim()) ? null : [line];
    } else if (current) {
      current.push(line);
    }
    // Bare keys before the first table header are intentionally dropped:
    // appended at the end of the document they would bind to the wrong table.
  }
  flush();

  let merged = base.replace(/\s+$/, '');
  for (const chunk of chunks) {
    const trimmed = chunk.replace(/^\s+|\s+$/g, '');
    if (trimmed) merged = `${merged}\n\n${trimmed}`;
  }
  merged = ensureCodexHooksFeature(merged);
  return merged.length > 0 && !merged.endsWith('\n') ? `${merged}\n` : merged;
}

function ensureCodexHooksFeature(toml: string): string {
  const body = toml.replace(/\s+$/, '');
  const lines = body.split('\n');
  const featuresIndex = lines.findIndex((line) => /^\s*\[features\]\s*$/.test(line));
  if (featuresIndex === -1) {
    return body ? `${body}\n\n[features]\nhooks = true\n` : '[features]\nhooks = true\n';
  }
  let sectionEnd = lines.length;
  for (let i = featuresIndex + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i])) { sectionEnd = i; break; }
  }
  const hasHooks = lines.slice(featuresIndex + 1, sectionEnd).some((line) => /^\s*hooks\s*=/.test(line));
  if (!hasHooks) lines.splice(featuresIndex + 1, 0, 'hooks = true');
  return `${lines.join('\n')}\n`;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pickStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && typeof entry === 'string') out[key] = entry;
  }
  return out;
}

export function parseClaudeSnapshot(raw: string): { env: Record<string, string>; model?: string } {
  const parsed = safeJson(raw);
  if (!parsed || typeof parsed !== 'object') return { env: {} };
  const snapshot = parsed as Record<string, unknown>;
  return {
    env: pickStringMap(snapshot.env),
    model: typeof snapshot.model === 'string' && snapshot.model.length <= 200 ? snapshot.model : undefined,
  };
}

export function parseClaudeCommon(raw: string | null): Record<string, string> {
  if (!raw) return {};
  const parsed = safeJson(raw);
  if (!parsed || typeof parsed !== 'object') return {};
  return pickStringMap((parsed as Record<string, unknown>).env);
}

export function parseCodexSnapshot(raw: string): { auth: Record<string, unknown> | null; config: string } {
  const parsed = safeJson(raw);
  if (!parsed || typeof parsed !== 'object') return { auth: null, config: '' };
  const snapshot = parsed as Record<string, unknown>;
  const auth = snapshot.auth && typeof snapshot.auth === 'object' && !Array.isArray(snapshot.auth)
    ? snapshot.auth as Record<string, unknown>
    : null;
  return {
    auth: auth && Object.keys(auth).length > 0 ? auth : null,
    config: typeof snapshot.config === 'string' ? snapshot.config : '',
  };
}

async function atomicWrite(target: string, content: string, mode: number): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(temp, content, { encoding: 'utf-8', mode });
    await fs.promises.rename(temp, target);
    // Overwriting via rename keeps the temp file's mode, but chmod anyway so a
    // pre-existing looser mode can never survive an override rewrite.
    await fs.promises.chmod(target, mode).catch(() => undefined);
  } finally {
    await fs.promises.unlink(temp).catch(() => undefined);
  }
}

export async function writeClaudeOverride(
  artifactsRoot: string,
  sessionId: string,
  snapshot: { env: Record<string, string>; model?: string },
  commonEnv: Record<string, string>,
): Promise<string> {
  const doc = buildClaudeSettingsJson(snapshot.env, commonEnv, snapshot.model);
  const target = path.join(artifactsRoot, `claude-${sessionId}.json`);
  await atomicWrite(target, `${JSON.stringify(doc, null, 2)}\n`, 0o600);
  return target;
}

export async function writeCodexHome(
  artifactsRoot: string,
  globalHome: string,
  sessionId: string,
  snapshot: { auth: Record<string, unknown> | null; config: string },
  commonToml: string,
): Promise<string> {
  const home = path.join(artifactsRoot, `codex-home-${sessionId}`);
  await fs.promises.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(home, 0o700).catch(() => undefined);

  // auth.json: provider credentials win; an empty snapshot means "whatever the
  // global CODEX_HOME currently has" (e.g. the ChatGPT-login provider).
  const authTarget = path.join(home, 'auth.json');
  if (snapshot.auth) {
    await atomicWrite(authTarget, `${JSON.stringify(snapshot.auth, null, 2)}\n`, 0o600);
  } else {
    await fs.promises.copyFile(path.join(globalHome, 'auth.json'), authTarget)
      .then(() => fs.promises.chmod(authTarget, 0o600))
      .catch(() => undefined);
  }

  const baseConfig = snapshot.config.trim().length > 0
    ? snapshot.config
    : await fs.promises.readFile(path.join(globalHome, 'config.toml'), 'utf-8').catch(() => '');
  await atomicWrite(path.join(home, 'config.toml'), buildCodexConfigToml(baseConfig, commonToml), 0o600);

  await linkSharedCodexEntries(globalHome, home);
  return home;
}

async function linkSharedCodexEntries(globalHome: string, instanceHome: string): Promise<void> {
  for (const entry of CODEX_HOME_SYMLINKS) {
    const source = path.join(globalHome, entry);
    try {
      await fs.promises.lstat(source); // only link what actually exists
      await fs.promises.symlink(source, path.join(instanceHome, entry));
    } catch {
      // Missing source or an already-existing target: leave the instance as-is.
    }
  }
}
