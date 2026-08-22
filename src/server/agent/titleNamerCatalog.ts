import { execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { loadPlugins, type PluginTitleNamerConfig } from './plugins.js';
import { getAutoRenameAgentsSetting, getAutoRenameNamerSetting } from '../utils/settings.js';

const execFileAsync = promisify(execFile);
const CACHE_FRESH_MS = 24 * 60 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const CACHE_FILE = path.join(os.homedir(), '.termdock', 'title-namer-catalog.json');

function pluginCommandEnv(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'];
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1', TERM: 'dumb' };
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('LC_') && value !== undefined) env[key] = value;
  }
  return env;
}

export interface TitleNamerModel {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  isEconomical?: boolean;
}

export interface TitleNamerInfo {
  slug: string;
  displayName: string;
  available: boolean;
  models: TitleNamerModel[];
  recommendedModel: string | null;
}

export interface PluginTitleNamerDoctorResult {
  slug: string;
  displayName: string;
  hasTitleNamer: boolean;
  hasModelCommand: boolean;
  status: 'ok' | 'missing-title-namer' | 'cli-default' | 'no-models' | 'probe-failed';
  models: TitleNamerModel[];
  recommendedModel: string | null;
  selectionBehavior: string;
  warnings: string[];
  error: string | null;
  nextSteps: string[];
}

export interface NormalizedModelCatalog {
  models: TitleNamerModel[];
  recommendedModel: string | null;
  ignoredEntries: number;
}

interface CatalogCacheDoc {
  version: 1;
  updatedAt: number;
  value: TitleNamerInfo[];
}

let cached: CatalogCacheDoc | null = null;
let refreshPromise: Promise<TitleNamerInfo[]> | null = null;

export function invalidateTitleNamerCatalog(): void {
  cached = null;
}

function normalizeCachedCatalog(input: unknown): CatalogCacheDoc | null {
  if (!input || typeof input !== 'object') return null;
  const doc = input as Partial<CatalogCacheDoc>;
  if (doc.version !== 1 || typeof doc.updatedAt !== 'number' || !Array.isArray(doc.value)) return null;
  const value = doc.value.flatMap((entry): TitleNamerInfo[] => {
    if (!entry || typeof entry !== 'object') return [];
    const candidate = entry as Partial<TitleNamerInfo>;
    if (typeof candidate.slug !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(candidate.slug)) return [];
    if (!Array.isArray(candidate.models)) return [];
    const catalog = normalizeDiscoveredModelCatalog({
      models: candidate.models,
      recommendedModel: candidate.recommendedModel,
    });
    return [{
      slug: candidate.slug,
      displayName: typeof candidate.displayName === 'string' ? candidate.displayName : candidate.slug,
      available: candidate.available === true,
      models: catalog.models,
      recommendedModel: catalog.recommendedModel,
    }];
  });
  return value.length > 0 ? { version: 1, updatedAt: doc.updatedAt, value } : null;
}

async function loadPersistentCache(): Promise<CatalogCacheDoc | null> {
  try {
    return normalizeCachedCatalog(JSON.parse(await fs.promises.readFile(CACHE_FILE, 'utf8')));
  } catch {
    return null;
  }
}

async function savePersistentCache(doc: CatalogCacheDoc): Promise<void> {
  const directory = path.dirname(CACHE_FILE);
  const temporary = `${CACHE_FILE}.${process.pid}.tmp`;
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(temporary, JSON.stringify(doc, null, 2), 'utf8');
  await fs.promises.rename(temporary, CACHE_FILE);
}

export function recommendTitleModel(models: TitleNamerModel[]): string | null {
  return models.find((model) => model.isEconomical)?.id
    ?? models.find((model) => model.isDefault)?.id
    ?? null;
}

async function listCodexModels(): Promise<TitleNamerModel[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    });
    let buffer = '';
    let settled = false;
    const finish = (models?: TitleNamerModel[], error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(models ?? []);
    };
    const timer = setTimeout(() => finish(undefined, new Error('Codex model discovery timed out')), PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.on('error', (error) => finish(undefined, error));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: { id?: number; result?: unknown };
        try { message = JSON.parse(line) as { id?: number; result?: unknown }; } catch { continue; }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'model/list', params: { limit: 100 } })}\n`);
        } else if (message.id === 2) {
          const data = (message.result as { data?: unknown } | undefined)?.data;
          const models = Array.isArray(data) ? data.flatMap((entry): TitleNamerModel[] => {
            if (!entry || typeof entry !== 'object') return [];
            const model = entry as Record<string, unknown>;
            if (typeof model.model !== 'string' || typeof model.displayName !== 'string') return [];
            return [{
              id: model.model,
              displayName: model.displayName,
              description: typeof model.description === 'string' ? model.description : '',
              isDefault: model.isDefault === true,
              isEconomical: false,
            }];
          }) : [];
          finish(models);
        }
      }
    });
    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'termdock', version: '1' } },
    })}\n`);
  });
}

export function parseClaudeSupportedModels(output: string): TitleNamerModel[] {
  const match = output.match(/supported (?:API )?model names are ([^\n]+?)(?:,?\s+but you passed|$)/i);
  if (!match) return [];
  return match[1]
    .split(/,|\band\b/i)
    .map((model) => model.trim().replace(/^["'`]+|["'`]+$/g, ''))
    .filter((model) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(model))
    .map((model) => ({ id: model, displayName: model, description: '', isDefault: false, isEconomical: false }));
}

async function listClaudeModels(): Promise<TitleNamerModel[]> {
  try {
    await execFileAsync('claude', ['--model', '__termdock_model_probe__', '--no-session-persistence', '-p', 'x'], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 128 * 1024,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    });
    return [];
  } catch (error) {
    const candidate = error as { code?: string; stdout?: string; stderr?: string };
    if (candidate.code === 'ENOENT') throw error;
    return parseClaudeSupportedModels(`${candidate.stdout ?? ''}\n${candidate.stderr ?? ''}`);
  }
}

export function normalizeDiscoveredModelCatalog(input: unknown): NormalizedModelCatalog {
  const root = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
  const entries = Array.isArray(input)
    ? input
    : Array.isArray(root?.models)
      ? root.models
      : Array.isArray(root?.data)
        ? root.data
        : [];
  let ignoredEntries = 0;
  const seenIds = new Set<string>();
  const models = entries.flatMap((entry): TitleNamerModel[] => {
    const rawId = typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object'
        ? (() => {
          const model = entry as Record<string, unknown>;
          return typeof model.id === 'string'
            ? model.id
            : typeof model.name === 'string'
              ? model.name
              : typeof model.model === 'string'
                ? model.model
                : '';
        })()
        : '';
    const id = rawId.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(id) || seenIds.has(id)) {
      ignoredEntries += 1;
      return [];
    }
    seenIds.add(id);
    if (typeof entry === 'string') {
      return [{ id, displayName: id, description: '', isDefault: false, isEconomical: false }];
    }
    if (!entry || typeof entry !== 'object') {
      ignoredEntries += 1;
      return [];
    }
    const model = entry as Record<string, unknown>;
    const rawDisplayName = typeof model.displayName === 'string'
      ? model.displayName
      : typeof model.display_name === 'string'
        ? model.display_name
        : typeof model.label === 'string'
          ? model.label
          : id;
    const displayName = rawDisplayName.trim().slice(0, 160) || id;
    return [{
      id,
      displayName,
      description: typeof model.description === 'string' ? model.description.trim().slice(0, 1000) : '',
      isDefault: model.isDefault === true || model.is_default === true || model.default === true,
      isEconomical: model.isEconomical === true || model.is_economical === true || model.economical === true,
    }];
  });
  const declared = typeof (root?.recommendedModel ?? root?.recommended_model) === 'string'
    ? String(root?.recommendedModel ?? root?.recommended_model).trim()
    : '';
  const recommendedModel = declared && models.some((model) => model.id === declared)
    ? declared
    : recommendTitleModel(models);
  return { models, recommendedModel, ignoredEntries };
}

function expandPluginPath(value: string, pluginDir: string): string {
  return value.replaceAll('{pluginDir}', pluginDir);
}

async function listPluginModels(config: PluginTitleNamerConfig, pluginDir: string): Promise<NormalizedModelCatalog> {
  if (!config.models) return { models: [], recommendedModel: null, ignoredEntries: 0 };
  const { stdout } = await execFileAsync(
    expandPluginPath(config.models.command, pluginDir),
    (config.models.args ?? []).map((arg) => expandPluginPath(arg, pluginDir)),
    {
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
    cwd: pluginDir,
    env: pluginCommandEnv(),
    },
  );
  return normalizeDiscoveredModelCatalog(JSON.parse(stdout));
}

function pluginTitleNamers() {
  return loadPlugins().plugins.flatMap((plugin) => plugin.manifest.titleNamer
    ? [{
      slug: plugin.manifest.slug,
      displayName: plugin.manifest.displayName,
      config: plugin.manifest.titleNamer,
      dir: plugin.dir,
    }]
    : []);
}

export function shouldRunPluginTitleCommands(slug: string, selected: string, enabledAgents: string[]): boolean {
  return selected === slug
    || (selected === 'auto' && enabledAgents.includes(slug));
}

function isPluginTitleExecutionEnabled(slug: string): boolean {
  return shouldRunPluginTitleCommands(slug, getAutoRenameNamerSetting(), getAutoRenameAgentsSetting());
}

async function cacheExplicitPluginProbe(slug: string, displayName: string, catalog: NormalizedModelCatalog): Promise<void> {
  if (!cached) cached = await loadPersistentCache();
  const current = cached?.value ?? await getTitleNamerCatalog();
  const value = current.map((entry): TitleNamerInfo => entry.slug === slug
    ? {
      slug,
      displayName,
      available: true,
      models: catalog.models,
      recommendedModel: catalog.recommendedModel,
    }
    : entry);
  cached = { version: 1, updatedAt: Date.now(), value };
  await savePersistentCache(cached).catch(() => undefined);
}

function expandTitleArg(value: string, pluginDir: string, prompt: string, model: string): string {
  return expandPluginPath(value, pluginDir).replaceAll('{prompt}', prompt).replaceAll('{model}', model);
}

export function buildPluginTitleArgs(
  config: PluginTitleNamerConfig,
  pluginDir: string,
  prompt: string,
  model?: string,
): string[] {
  const baseArgs: string[] = [];
  for (const arg of config.args) {
    if (arg.includes('{model}') && !model) {
      // Legacy v2 manifests put paired flags in args. Remove an immediately
      // preceding standalone flag too, so `-c model={model}` cannot degrade
      // into the invalid `-c -p ...`. New plugins should use modelArgs.
      if (baseArgs.at(-1)?.startsWith('-') && !baseArgs.at(-1)?.includes('=')) baseArgs.pop();
      continue;
    }
    baseArgs.push(expandTitleArg(arg, pluginDir, prompt, model ?? ''));
  }
  const selectedModelArgs = model && config.modelArgs
    ? config.modelArgs.map((arg) => expandTitleArg(arg, pluginDir, prompt, model))
    : [];
  return [...selectedModelArgs, ...baseArgs];
}

export async function probePluginTitleNamer(slug: string): Promise<PluginTitleNamerDoctorResult | null> {
  const plugin = loadPlugins().plugins.find((entry) => entry.manifest.slug === slug);
  if (!plugin) return null;
  const config = plugin.manifest.titleNamer;
  if (!config) {
    return {
      slug,
      displayName: plugin.manifest.displayName,
      hasTitleNamer: false,
      hasModelCommand: false,
      status: 'missing-title-namer',
      models: [],
      recommendedModel: null,
      selectionBehavior: 'This plugin cannot generate titles until manifest.titleNamer is added.',
      warnings: ['manifest.json has no titleNamer declaration.'],
      error: null,
      nextSteps: ['Run `td agent-plugin --json`, add manifest.titleNamer, then update/reinstall the plugin.'],
    };
  }
  const warnings: string[] = [];
  if (!config.modelArgs && config.args.some((arg) => arg.includes('{model}'))) {
    warnings.push('Legacy {model} placement detected in args; use modelArgs for optional paired flags.');
  }
  if (!config.models) {
    return {
      slug,
      displayName: plugin.manifest.displayName,
      hasTitleNamer: true,
      hasModelCommand: false,
      status: 'cli-default',
      models: [],
      recommendedModel: null,
      selectionBehavior: 'Termdock will omit all model arguments and use the Agent CLI default model.',
      warnings,
      error: null,
      nextSteps: ['Optional: add titleNamer.models to expose selectable models; otherwise the CLI default is used.'],
    };
  }
  try {
    const catalog = await listPluginModels(config, plugin.dir);
    await cacheExplicitPluginProbe(slug, plugin.manifest.displayName, catalog);
    if (catalog.ignoredEntries > 0) {
      warnings.push(`${catalog.ignoredEntries} model entr${catalog.ignoredEntries === 1 ? 'y was' : 'ies were'} ignored because its identifier was invalid or duplicated.`);
    }
    if (catalog.models.length > 0 && !catalog.recommendedModel) {
      warnings.push('No recommendedModel, isEconomical, or isDefault marker was found; automatic mode will use the Agent CLI default model.');
    }
    return {
      slug,
      displayName: plugin.manifest.displayName,
      hasTitleNamer: true,
      hasModelCommand: true,
      status: catalog.models.length > 0 ? 'ok' : 'no-models',
      models: catalog.models,
      recommendedModel: catalog.recommendedModel,
      selectionBehavior: catalog.recommendedModel
        ? `Automatic selection will pass model ${catalog.recommendedModel}.`
        : 'No recommended model was declared; Termdock will omit model arguments and use the Agent CLI default model.',
      warnings: catalog.models.length === 0
        ? [...warnings, 'The model command succeeded but returned no usable models.']
        : warnings,
      error: null,
      nextSteps: catalog.models.length > 0
        ? catalog.recommendedModel
          ? ['Select this provider/model in Settings, then enable automatic titles for the Agent.']
          : ['Declare recommendedModel, mark one model isEconomical/isDefault, or let users select a model manually.']
        : ['Return a JSON array (or {models}) using id/name/model plus optional displayName, description, isDefault, and isEconomical fields.'],
    };
  } catch (error) {
    return {
      slug,
      displayName: plugin.manifest.displayName,
      hasTitleNamer: true,
      hasModelCommand: true,
      status: 'probe-failed',
      models: [],
      recommendedModel: null,
      selectionBehavior: 'Model selection is unavailable until the probe succeeds; title generation falls back to the Agent CLI default model.',
      warnings,
      error: (error as Error).message,
      nextSteps: ['Run the declared models command directly, ensure it prints JSON only, or use a {pluginDir} adapter script to normalize its output.'],
    };
  }
}

export async function runTitleNamer(slug: string, prompt: string, model?: string): Promise<string | null> {
  let command: string;
  let args: string[];
  let cwd: string | undefined;
  if (slug === 'codex') {
    command = 'codex';
    args = ['exec', '--ephemeral', '--skip-git-repo-check', '--color', 'never', ...(model ? ['--model', model] : []), prompt];
  } else if (slug === 'claude') {
    command = 'claude';
    args = [...(model ? ['--model', model] : []), '--no-session-persistence', '-p', prompt];
  } else {
    const provider = pluginTitleNamers().find((entry) => entry.slug === slug);
    if (!provider || !isPluginTitleExecutionEnabled(slug)) return null;
    cwd = provider.dir;
    command = expandPluginPath(provider.config.command, provider.dir);
    args = buildPluginTitleArgs(provider.config, provider.dir, prompt, model);
  }
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 45_000,
      maxBuffer: 256 * 1024,
      cwd,
      env: cwd ? pluginCommandEnv() : { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
    });
    return stdout;
  } catch {
    return null;
  }
}

async function refreshTitleNamerCatalog(): Promise<TitleNamerInfo[]> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
  const plugins = pluginTitleNamers();
  const [codex, claude, ...pluginResults] = await Promise.allSettled([
    listCodexModels(),
    listClaudeModels(),
    ...plugins.map((provider) => provider.config.models && isPluginTitleExecutionEnabled(provider.slug)
      ? listPluginModels(provider.config, provider.dir)
      : Promise.resolve({ models: [], recommendedModel: null, ignoredEntries: 0 })),
  ]);
  const previousCodex = cached?.value.find((namer) => namer.slug === 'codex');
  const previousClaude = cached?.value.find((namer) => namer.slug === 'claude');
  const codexModels = codex.status === 'fulfilled' ? codex.value : previousCodex?.models ?? [];
  const claudeModels = claude.status === 'fulfilled' ? claude.value : previousClaude?.models ?? [];
  const value: TitleNamerInfo[] = [
    {
      slug: 'codex',
      displayName: 'Codex',
      available: codex.status === 'fulfilled' || previousCodex?.available === true,
      models: codexModels,
      recommendedModel: recommendTitleModel(codexModels),
    },
    {
      slug: 'claude',
      displayName: 'Claude Code',
      available: claude.status === 'fulfilled' || previousClaude?.available === true,
      models: claudeModels,
      recommendedModel: recommendTitleModel(claudeModels),
    },
    ...plugins.map((provider, index): TitleNamerInfo => {
      const result = pluginResults[index];
      const previous = cached?.value.find((namer) => namer.slug === provider.slug);
      const discovered = result?.status === 'fulfilled' ? result.value : null;
      const models = discovered?.models ?? previous?.models ?? [];
      return {
        slug: provider.slug,
        displayName: provider.displayName,
        available: provider.config.models ? result?.status === 'fulfilled' || previous?.available === true : true,
        models,
        recommendedModel: discovered?.recommendedModel ?? recommendTitleModel(models),
      };
    }),
  ];
    cached = { version: 1, updatedAt: Date.now(), value };
    await savePersistentCache(cached).catch(() => undefined);
    return value;
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export async function getTitleNamerCatalog(force = false): Promise<TitleNamerInfo[]> {
  if (force) return refreshTitleNamerCatalog();
  if (!cached) cached = await loadPersistentCache();
  if (!cached) return refreshTitleNamerCatalog();

  const expectedSlugs = new Set(['codex', 'claude', ...pluginTitleNamers().map((provider) => provider.slug)]);
  if (cached.value.length !== expectedSlugs.size || cached.value.some((entry) => !expectedSlugs.has(entry.slug))) {
    return refreshTitleNamerCatalog();
  }

  if (Date.now() - cached.updatedAt > CACHE_FRESH_MS) {
    // Stale-while-revalidate: callers get the last known catalog immediately.
    void refreshTitleNamerCatalog();
  }
  return cached.value;
}
