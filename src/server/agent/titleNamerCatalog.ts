import { execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

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
  slug: 'codex' | 'claude';
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

function normalizeCachedCatalog(input: unknown): CatalogCacheDoc | null {
  if (!input || typeof input !== 'object') return null;
  const doc = input as Partial<CatalogCacheDoc>;
  if (doc.version !== 1 || typeof doc.updatedAt !== 'number' || !Array.isArray(doc.value)) return null;
  const value = doc.value.flatMap((entry): TitleNamerInfo[] => {
    if (!entry || typeof entry !== 'object') return [];
    const candidate = entry as Partial<TitleNamerInfo>;
    if (candidate.slug !== 'codex' && candidate.slug !== 'claude') return [];
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

async function refreshTitleNamerCatalog(): Promise<TitleNamerInfo[]> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
  const [codex, claude] = await Promise.allSettled([listCodexModels(), listClaudeModels()]);
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

  if (Date.now() - cached.updatedAt > CACHE_FRESH_MS) {
    // Stale-while-revalidate: callers get the last known catalog immediately.
    void refreshTitleNamerCatalog();
  }
  return cached.value;
}
