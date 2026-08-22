import { execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { loadPlugins, type PluginTitleNamerConfig } from './plugins.js';

const execFileAsync = promisify(execFile);
const CACHE_FRESH_MS = 24 * 60 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const CACHE_FILE = path.join(os.homedir(), '.termdock', 'title-namer-catalog.json');

export interface TitleNamerModel {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}

export interface TitleNamerInfo {
  slug: string;
  displayName: string;
  available: boolean;
  models: TitleNamerModel[];
  recommendedModel: string | null;
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
    const models = candidate.models.filter((model): model is TitleNamerModel => Boolean(
      model
      && typeof model.id === 'string'
      && typeof model.displayName === 'string'
      && typeof model.description === 'string'
      && typeof model.isDefault === 'boolean',
    ));
    return [{
      slug: candidate.slug,
      displayName: typeof candidate.displayName === 'string' ? candidate.displayName : candidate.slug,
      available: candidate.available === true,
      models,
      recommendedModel: typeof candidate.recommendedModel === 'string'
        ? candidate.recommendedModel
        : recommendTitleModel(models),
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
  return models.find((model) => /affordable|cost[- ]efficient|cost[- ]sensitive/i.test(model.description))?.id
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
    .map((model) => ({ id: model, displayName: model, description: '', isDefault: false }));
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

function normalizeDiscoveredModels(input: unknown): TitleNamerModel[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((entry): TitleNamerModel[] => {
    if (typeof entry === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(entry)) {
      return [{ id: entry, displayName: entry, description: '', isDefault: false }];
    }
    if (!entry || typeof entry !== 'object') return [];
    const model = entry as Record<string, unknown>;
    if (typeof model.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(model.id)) return [];
    return [{
      id: model.id,
      displayName: typeof model.displayName === 'string' ? model.displayName : model.id,
      description: typeof model.description === 'string' ? model.description : '',
      isDefault: model.isDefault === true,
    }];
  });
}

async function listPluginModels(config: PluginTitleNamerConfig): Promise<TitleNamerModel[]> {
  if (!config.models) return [];
  const { stdout } = await execFileAsync(config.models.command, config.models.args ?? [], {
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
    env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
  });
  return normalizeDiscoveredModels(JSON.parse(stdout));
}

function pluginTitleNamers() {
  return loadPlugins().plugins.flatMap((plugin) => plugin.manifest.titleNamer
    ? [{
      slug: plugin.manifest.slug,
      displayName: plugin.manifest.displayName,
      config: plugin.manifest.titleNamer,
    }]
    : []);
}

export async function runTitleNamer(slug: string, prompt: string, model?: string): Promise<string | null> {
  let command: string;
  let args: string[];
  if (slug === 'codex') {
    command = 'codex';
    args = ['exec', '--ephemeral', '--skip-git-repo-check', '--color', 'never', ...(model ? ['--model', model] : []), prompt];
  } else if (slug === 'claude') {
    command = 'claude';
    args = [...(model ? ['--model', model] : []), '--no-session-persistence', '-p', prompt];
  } else {
    const provider = pluginTitleNamers().find((entry) => entry.slug === slug);
    if (!provider) return null;
    command = provider.config.command;
    args = provider.config.args.flatMap((arg) => {
      if (arg.includes('{model}') && !model) return [];
      return [arg.replaceAll('{prompt}', prompt).replaceAll('{model}', model ?? '')];
    });
  }
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 45_000,
      maxBuffer: 256 * 1024,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
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
    ...plugins.map((provider) => listPluginModels(provider.config)),
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
      const models = result?.status === 'fulfilled' ? result.value : previous?.models ?? [];
      return {
        slug: provider.slug,
        displayName: provider.displayName,
        available: provider.config.models ? result?.status === 'fulfilled' || previous?.available === true : true,
        models,
        recommendedModel: recommendTitleModel(models),
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
