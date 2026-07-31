/**
 * QuotaManager — periodic polling, caching, and broadcasting of subscription quotas.
 *
 * On start, discovers available providers (tokens found in agent configs),
 * fetches initial quota data, caches to ~/.termdock/quota-cache.json,
 * then polls every 10 minutes. Diffs results and broadcasts changes via
 * the global session WS channel.
 */

import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import type { QuotaResult, QuotaStatus, QuotaStatusWirePayload } from './types.js';
import { fetchClaudeQuota, isClaudeAvailable } from './providers/claude.js';
import { fetchCodexQuota, isCodexAvailable } from './providers/codex.js';
import { fetchKimiQuota, isKimiAvailable } from './providers/kimi.js';
import { fetchCopilotQuota, isCopilotAvailable } from './providers/copilot.js';
import { fetchGrokQuota, isGrokAvailable } from './providers/grok.js';
import { fetchGeminiQuota, isGeminiAvailable } from './providers/gemini.js';

const CACHE_PATH = path.join(homedir(), '.termdock', 'quota-cache.json');
const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const INITIAL_FETCH_DELAY_MS = 5_000; // 5s after server start

type FetchFn = () => Promise<QuotaResult>;
type IsAvailableFn = () => boolean;

interface ProviderEntry {
  slug: string;
  displayName: string;
  fetch: FetchFn;
  isAvailable: IsAvailableFn;
}

const PROVIDERS: ProviderEntry[] = [
  { slug: 'claude', displayName: 'Claude', fetch: fetchClaudeQuota, isAvailable: isClaudeAvailable },
  { slug: 'codex', displayName: 'Codex', fetch: fetchCodexQuota, isAvailable: isCodexAvailable },
  { slug: 'kimi', displayName: 'Kimi', fetch: fetchKimiQuota, isAvailable: isKimiAvailable },
  { slug: 'copilot', displayName: 'GitHub Copilot', fetch: fetchCopilotQuota, isAvailable: isCopilotAvailable },
  { slug: 'grok', displayName: 'Grok', fetch: fetchGrokQuota, isAvailable: isGrokAvailable },
  { slug: 'gemini', displayName: 'Gemini', fetch: fetchGeminiQuota, isAvailable: isGeminiAvailable },
];

let currentStatus: QuotaStatus = { providers: [], updatedAt: 0 };
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let broadcastFn: ((payload: QuotaStatusWirePayload) => void) | null = null;

function loadCache(): QuotaStatus | null {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as QuotaStatus;
      if (parsed && Array.isArray(parsed.providers)) {
        return parsed;
      }
    }
  } catch {
    // Corrupt cache — ignore.
  }
  return null;
}

function saveCache(status: QuotaStatus): void {
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CACHE_PATH, JSON.stringify(status, null, 2));
  } catch {
    // Best-effort persistence.
  }
}

function hasChanged(a: QuotaResult[], b: QuotaResult[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].usagePercent !== b[i].usagePercent) return true;
    if (a[i].error !== b[i].error) return true;
    if (a[i].remaining !== b[i].remaining) return true;
  }
  return false;
}

async function pollOnce(): Promise<void> {
  const available = PROVIDERS.filter((p) => p.isAvailable());

  const results = await Promise.allSettled(
    available.map(async (p) => {
      try {
        return await p.fetch();
      } catch {
        return {
          slug: p.slug,
          displayName: p.displayName,
          usagePercent: 0,
          windows: [],
          error: 'Fetch failed',
          fetchedAt: Date.now(),
        } as QuotaResult;
      }
    }),
  );

  const providers = results.map((r) =>
    r.status === 'fulfilled' ? r.value : {
      slug: 'unknown',
      displayName: 'Unknown',
      usagePercent: 0,
      windows: [],
      error: 'Internal error',
      fetchedAt: Date.now(),
    } as QuotaResult,
  );

  const prev = currentStatus.providers;
  const changed = hasChanged(prev, providers);

  currentStatus = { providers, updatedAt: Date.now() };
  saveCache(currentStatus);

  if (changed && broadcastFn) {
    broadcastFn({
      type: 'quota-status',
      providers,
      updatedAt: currentStatus.updatedAt,
    });
  }
}

/** Start the QuotaManager. Called once on server init. */
export function startQuotaManager(opts: {
  broadcast: (payload: QuotaStatusWirePayload) => void;
}): void {
  broadcastFn = opts.broadcast;

  // Load cached data for immediate availability
  const cached = loadCache();
  if (cached && cached.providers.length > 0) {
    currentStatus = cached;
  }

  // Initial fetch after a short delay (let server settle)
  setTimeout(() => {
    pollOnce().catch(() => {});
  }, INITIAL_FETCH_DELAY_MS);

  // Periodic polling
  pollTimer = setInterval(() => {
    pollOnce().catch(() => {});
  }, POLL_INTERVAL_MS);
}

/** Stop the QuotaManager. Called on server shutdown. */
export function stopQuotaManager(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  broadcastFn = null;
}

/** Get the latest cached quota status. Used by REST endpoint. */
export function getQuotaStatus(): QuotaStatus {
  return currentStatus;
}

/** Force a refresh. Used by the "Refresh" button in the UI. */
export async function refreshQuota(): Promise<QuotaStatus> {
  await pollOnce();
  return currentStatus;
}
