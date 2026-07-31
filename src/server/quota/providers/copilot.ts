/**
 * GitHub Copilot subscription quota provider.
 *
 * Copilot's usage API is internal (not publicly documented). We attempt
 * multiple endpoints that the Copilot extension and CLI use.
 */

import type { QuotaResult, QuotaWindow } from '../types.js';
import { discoverCopilotTokens } from '../tokenDiscovery.js';

const COPILOT_CHAT_USAGE = 'https://api.github.com/copilot/usage';
const COPILOT_QUOTA = 'https://api.github.com/user/copilot/quotas';

interface CopilotQuotaResponse {
  chat?: {
    used?: number;
    limit?: number;
  };
  completions?: {
    used?: number;
    limit?: number;
  };
  overage?: {
    cost?: number;
    requests?: number;
  };
}

async function fetchWithAuth(
  token: string,
): Promise<CopilotQuotaResponse | null> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': 'termdock/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Try the quotas endpoint first
  for (const url of [COPILOT_QUOTA, COPILOT_CHAT_USAGE]) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        return res.json() as Promise<CopilotQuotaResponse>;
      }
      if (res.status === 401) throw new Error('Copilot: token expired');
      if (res.status === 403) continue; // might not have copilot access
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Copilot:')) throw e;
    }
  }

  return null;
}

export async function fetchCopilotQuota(): Promise<QuotaResult> {
  const tokens = discoverCopilotTokens();
  const result: QuotaResult = {
    slug: 'copilot',
    displayName: 'GitHub Copilot',
    usagePercent: 0,
    windows: [],
    fetchedAt: Date.now(),
  };

  if (tokens.length === 0) {
    result.error = 'No GitHub Copilot token found';
    return result;
  }

  let data: CopilotQuotaResponse | null = null;
  let lastError = '';

  for (const t of tokens) {
    try {
      data = await fetchWithAuth(t.token);
      if (data) break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  if (!data) {
    result.error = lastError || 'Failed to fetch Copilot usage';
    return result;
  }

  const windows: QuotaWindow[] = [];
  let worstPercent = 0;
  let totalRemaining = 0;
  let totalEntitlement = 0;

  if (data.chat) {
    const used = data.chat.used || 0;
    const limit = data.chat.limit || 0;
    if (limit > 0) {
      const pct = (used / limit) * 100;
      windows.push({
        label: 'Chat',
        percent: Math.round(pct * 10) / 10,
        windowLabel: 'monthly',
      });
      if (pct > worstPercent) worstPercent = pct;
      totalRemaining += Math.max(0, limit - used);
      totalEntitlement += limit;
    }
  }

  if (data.completions) {
    const used = data.completions.used || 0;
    const limit = data.completions.limit || 0;
    if (limit > 0) {
      const pct = (used / limit) * 100;
      windows.push({
        label: 'Completions',
        percent: Math.round(pct * 10) / 10,
        windowLabel: 'monthly',
      });
      if (pct > worstPercent) worstPercent = pct;
      totalRemaining += Math.max(0, limit - used);
      totalEntitlement += limit;
    }
  }

  if (data.overage) {
    if (data.overage.cost !== undefined) {
      windows.push({
        label: 'Overage',
        percent: 0,
        windowLabel: `$${data.overage.cost.toFixed(2)}`,
      });
    }
  }

  if (windows.length === 0) {
    result.error = 'Copilot API returned no usage data';
    return result;
  }

  result.windows = windows;
  result.usagePercent = Math.round(worstPercent);
  result.remaining = totalRemaining || undefined;
  result.entitlement = totalEntitlement || undefined;

  return result;
}

export function isCopilotAvailable(): boolean {
  return discoverCopilotTokens().length > 0;
}
