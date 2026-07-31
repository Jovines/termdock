/**
 * Grok (xAI) subscription quota provider.
 */

import type { QuotaResult, QuotaWindow } from '../types.js';
import { discoverGrokTokens } from '../tokenDiscovery.js';

const USAGE_URL = 'https://api.x.ai/v1/usage';

interface GrokUsageResponse {
  usage?: {
    monthly_percent?: number;
    monthly_reset?: string;
    model_breakdown?: Record<string, number>;
  };
}

async function fetchWithAuth(token: string): Promise<GrokUsageResponse> {
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'termdock/1.0',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) throw new Error('Grok: token expired');
  if (!res.ok) throw new Error(`Grok: HTTP ${res.status}`);
  return res.json() as Promise<GrokUsageResponse>;
}

export async function fetchGrokQuota(): Promise<QuotaResult> {
  const tokens = discoverGrokTokens();
  const result: QuotaResult = {
    slug: 'grok',
    displayName: 'Grok',
    usagePercent: 0,
    windows: [],
    fetchedAt: Date.now(),
  };

  if (tokens.length === 0) {
    result.error = 'No Grok API key found';
    return result;
  }

  let data: GrokUsageResponse | null = null;
  let lastError = '';

  for (const t of tokens) {
    try {
      data = await fetchWithAuth(t.token);
      break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  if (!data?.usage) {
    result.error = lastError || 'No Grok usage data';
    return result;
  }

  const windows: QuotaWindow[] = [];
  const usage = data.usage;

  if (usage.monthly_percent !== undefined) {
    windows.push({
      label: 'Monthly',
      percent: usage.monthly_percent,
      resetAt: usage.monthly_reset,
      windowLabel: 'monthly',
    });
  }

  if (usage.model_breakdown) {
    for (const [model, pct] of Object.entries(usage.model_breakdown)) {
      windows.push({
        label: model,
        percent: pct,
        windowLabel: 'model',
      });
    }
  }

  result.windows = windows;
  result.usagePercent = Math.round(
    windows.length > 0 ? usage.monthly_percent || 0 : 0,
  );
  result.remaining = Math.max(0, 100 - result.usagePercent);
  result.entitlement = 100;

  return result;
}

export function isGrokAvailable(): boolean {
  return discoverGrokTokens().length > 0;
}
