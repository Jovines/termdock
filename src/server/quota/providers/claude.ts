/**
 * Claude / Anthropic subscription quota provider.
 *
 * Calls `GET https://api.anthropic.com/api/oauth/usage` with the OAuth
 * Bearer token discovered from OpenCode auth.json or Claude settings.json.
 * Returns per-window percentages (5h, 7d, Sonnet, Opus, Fable).
 */

import type { QuotaResult, QuotaWindow } from '../types.js';
import { discoverClaudeTokens } from '../tokenDiscovery.js';


const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

interface ClaudeUsageWindow {
  utilization: number;
  resets_at?: string;
}

interface ClaudeLimitEntry {
  kind?: string;
  percent?: number;
  resets_at?: string;
  scope?: { model?: { id?: string; display_name?: string } };
}

interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageWindow;
  seven_day?: ClaudeUsageWindow;
  seven_day_sonnet?: ClaudeUsageWindow;
  seven_day_opus?: ClaudeUsageWindow;
  limits?: ClaudeLimitEntry[];
}

async function fetchWithAuth(token: string): Promise<ClaudeUsageResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'termdock/1.0',
    'anthropic-beta': 'oauth-2025-04-20',
  };

  const res = await fetch(USAGE_URL, { headers, signal: AbortSignal.timeout(10_000) });
  if (res.status === 401) throw new Error('Claude: token expired');
  if (res.status === 429) throw new Error('Claude: rate limited');
  if (!res.ok) throw new Error(`Claude: HTTP ${res.status}`);
  return res.json() as Promise<ClaudeUsageResponse>;
}

export async function fetchClaudeQuota(): Promise<QuotaResult> {
  const tokens = discoverClaudeTokens();
  const result: QuotaResult = {
    slug: 'claude',
    displayName: 'Claude',
    usagePercent: 0,
    windows: [],
    fetchedAt: Date.now(),
  };

  if (tokens.length === 0) {
    result.error = 'No Claude token found';
    return result;
  }

  let usageData: ClaudeUsageResponse | null = null;
  let lastError = '';

  for (const t of tokens) {
    try {
      usageData = await fetchWithAuth(t.token);
      break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  if (!usageData) {
    result.error = lastError || 'Failed to fetch Claude usage';
    return result;
  }

  const windows: QuotaWindow[] = [];
  let worstPercent = 0;

  // 5-hour burst window
  if (usageData.five_hour) {
    const pct = usageData.five_hour.utilization;
    windows.push({
      label: '5-hour',
      percent: pct,
      resetAt: usageData.five_hour.resets_at,
      windowLabel: '5h',
    });
    if (pct > worstPercent) worstPercent = pct;
  }

  // 7-day rolling window (main quota)
  if (usageData.seven_day) {
    const pct = usageData.seven_day.utilization;
    windows.push({
      label: '7-day',
      percent: pct,
      resetAt: usageData.seven_day.resets_at,
      windowLabel: '7d',
    });
    if (pct > worstPercent) worstPercent = pct;
  }

  // Sonnet sub-quota
  if (usageData.seven_day_sonnet) {
    const pct = usageData.seven_day_sonnet.utilization;
    windows.push({
      label: 'Sonnet',
      percent: pct,
      resetAt: usageData.seven_day_sonnet.resets_at,
      windowLabel: '7d',
    });
  }

  // Opus sub-quota
  if (usageData.seven_day_opus) {
    windows.push({
      label: 'Opus',
      percent: usageData.seven_day_opus.utilization,
      resetAt: usageData.seven_day_opus.resets_at,
      windowLabel: '7d',
    });
  }

  // Fable weekly (from limits array)
  if (usageData.limits) {
    const fable = usageData.limits.find(
      (l) =>
        l.kind === 'weekly_scoped' &&
        l.scope?.model?.display_name?.toLowerCase() === 'fable',
    );
    if (fable?.percent !== undefined) {
      windows.push({
        label: 'Fable',
        percent: fable.percent,
        resetAt: fable.resets_at,
        windowLabel: '7d',
      });
    }
  }

  result.windows = windows;
  result.usagePercent = Math.round(worstPercent);
  result.remaining = Math.max(0, 100 - worstPercent);
  result.entitlement = 100;
  // Use the 7-day reset as the primary
  if (usageData.seven_day?.resets_at) {
    result.resetAt = usageData.seven_day.resets_at;
  }

  return result;
}

export function isClaudeAvailable(): boolean {
  return discoverClaudeTokens().length > 0;
}
