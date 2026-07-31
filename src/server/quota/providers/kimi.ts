/**
 * Kimi (Moonshot) subscription quota provider.
 *
 * Calls `GET https://api.kimi.com/coding/v1/usages` with the API key
 * discovered from env or kimi-code config.
 */

import type { QuotaResult, QuotaWindow } from '../types.js';
import { discoverKimiTokens } from '../tokenDiscovery.js';

const USAGE_URL = 'https://api.kimi.com/coding/v1/usages';

interface KimiUsageResponse {
  user?: { userId?: string; membership?: { level?: string } };
  usage?: {
    limit?: string;
    used?: string;
    remaining?: string;
    resetTime?: string;
  };
  limits?: Array<{
    window?: { duration?: number; timeUnit?: string };
    detail?: {
      limit?: string;
      used?: string;
      remaining?: string;
      resetTime?: string;
    };
  }>;
}

async function fetchWithAuth(token: string): Promise<KimiUsageResponse> {
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'termdock/1.0',
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401) throw new Error('Kimi: token expired');
  if (!res.ok) throw new Error(`Kimi: HTTP ${res.status}`);
  return res.json() as Promise<KimiUsageResponse>;
}

export async function fetchKimiQuota(): Promise<QuotaResult> {
  const tokens = discoverKimiTokens();
  const result: QuotaResult = {
    slug: 'kimi',
    displayName: 'Kimi',
    usagePercent: 0,
    windows: [],
    fetchedAt: Date.now(),
  };

  if (tokens.length === 0) {
    result.error = 'No Kimi API key found';
    return result;
  }

  let data: KimiUsageResponse | null = null;
  let lastError = '';

  for (const t of tokens) {
    try {
      data = await fetchWithAuth(t.token);
      break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  if (!data) {
    result.error = lastError || 'Failed to fetch Kimi usage';
    return result;
  }

  const windows: QuotaWindow[] = [];
  let worstPercent = 0;

  // Main usage
  const usage = data.usage;
  if (usage) {
    const limit = parseInt(usage.limit || '0', 10);
    const used = parseInt(usage.used || '0', 10);
    const remaining = parseInt(usage.remaining || '0', 10);
    if (limit > 0) {
      const pct = (used / limit) * 100;
      windows.push({
        label: 'Token',
        percent: Math.round(pct * 10) / 10,
        resetAt: usage.resetTime,
        windowLabel: 'total',
      });
      if (pct > worstPercent) worstPercent = pct;
      result.remaining = remaining;
      result.entitlement = limit;
    }
  }

  // Per-window limits
  if (data.limits) {
    for (const limit of data.limits) {
      if (limit.detail) {
        const d = limit.detail;
        const detailLimit = parseInt(d.limit || '0', 10);
        const detailUsed = parseInt(d.used || '0', 10);
        if (detailLimit > 0) {
          const pct = (detailUsed / detailLimit) * 100;
          const w = limit.window;
          const label = w
            ? `${w.duration || ''}${w.timeUnit || ''}`.replace(/^(\d+)([a-z])/, '$1$2')
            : 'Window';
          windows.push({
            label,
            percent: Math.round(pct * 10) / 10,
            resetAt: d.resetTime,
            windowLabel: label,
          });
        }
      }
    }
  }

  if (windows.length === 0) {
    result.error = 'Kimi API returned no usage data';
    return result;
  }

  result.windows = windows;
  result.usagePercent = Math.round(worstPercent);
  if (!result.entitlement) {
    result.usagePercent = Math.round(worstPercent);
    result.remaining = Math.max(0, 100 - worstPercent);
    result.entitlement = 100;
  }

  return result;
}

export function isKimiAvailable(): boolean {
  return discoverKimiTokens().length > 0;
}
