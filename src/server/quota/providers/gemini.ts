/**
 * Gemini CLI subscription quota provider.
 *
 * Attempts Google Cloud / Gemini API usage endpoint.
 */

import type { QuotaResult } from '../types.js';
import { discoverGeminiTokens } from '../tokenDiscovery.js';

const USAGE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/usage';

async function fetchWithAuth(token: string): Promise<any> {
  const res = await fetch(USAGE_URL, {
    headers: {
      'x-goog-api-key': token,
      Accept: 'application/json',
      'User-Agent': 'termdock/1.0',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error('Gemini: unauthorized');
  if (!res.ok) throw new Error(`Gemini: HTTP ${res.status}`);
  return res.json();
}

export async function fetchGeminiQuota(): Promise<QuotaResult> {
  const tokens = discoverGeminiTokens();
  const result: QuotaResult = {
    slug: 'gemini',
    displayName: 'Gemini',
    usagePercent: 0,
    windows: [],
    fetchedAt: Date.now(),
  };

  if (tokens.length === 0) {
    result.error = 'No Gemini API key found';
    return result;
  }

  // Gemini free-tier quotas are rate-limit based, not percentage-based.
  // The API key alone confirms the user has access.
  // For now show a simple "active" indicator; real quota needs OAuth.
  try {
    await fetchWithAuth(tokens[0].token);
    result.windows = [{ label: 'API', percent: 0, windowLabel: 'active' }];
    result.remaining = undefined;
    result.entitlement = undefined;
  } catch (e) {
    result.error = e instanceof Error ? e.message : 'Gemini fetch failed';
  }

  return result;
}

export function isGeminiAvailable(): boolean {
  return discoverGeminiTokens().length > 0;
}
