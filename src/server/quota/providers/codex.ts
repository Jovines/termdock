/**
 * Codex / OpenAI subscription quota provider.
 *
 * Quota sources (tried in order):
 * 1. chatgpt.com/backend-api/wham/usage — ChatGPT Plus/Pro web subscription
 * 2. api.openai.com/v1/organization/usage — API platform billing
 *
 * Tokens discovered from: ~/.codex/auth.json > OpenCode auth.json > env vars.
 */

import type { QuotaResult, QuotaWindow } from '../types.js';
import { discoverCodexTokens } from '../tokenDiscovery.js';

const WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage';
const API_BILLING_URL = 'https://api.openai.com/v1/organization/usage';
const ORG_LIST_URL = 'https://api.openai.com/v1/organizations';

// ── Wham response shape (chatgpt.com backend) ──

interface WhamWindow {
  used_percent: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

interface WhamRateLimit {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: WhamWindow;
  secondary_window?: WhamWindow | null;
}

interface WhamResponse {
  plan_type?: string;
  email?: string;
  rate_limit?: WhamRateLimit;
  code_review_rate_limit?: WhamRateLimit | null;
  additional_rate_limits?: Record<string, WhamRateLimit> | null;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: string;
  };
  spend_control?: {
    reached?: boolean;
  };
}

// ── API billing response ──

interface OrgUsageResponse {
  data?: Array<{
    usage_tokens?: number;
  }>;
}

async function fetchWham(token: string): Promise<WhamResponse | null> {
  const res = await fetch(WHAM_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return res.json() as Promise<WhamResponse>;
}

async function fetchApiBilling(token: string): Promise<number | null> {
  let orgId = '';
  try {
    const orgRes = await fetch(ORG_LIST_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (orgRes.ok) {
      const orgs = await orgRes.json() as { data?: Array<{ id: string }> };
      orgId = orgs.data?.[0]?.id || '';
    }
  } catch { /* optional */ }

  const res = await fetch(API_BILLING_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(orgId ? { 'OpenAI-Organization': orgId } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const data = await res.json() as OrgUsageResponse;
  return data.data?.[0]?.usage_tokens ?? null;
}

// ── Helpers ──

function unixToISO(ts?: number): string | undefined {
  if (!ts) return undefined;
  return new Date(ts * 1000).toISOString();
}

function windowLabelFromSeconds(seconds?: number): string {
  if (!seconds) return '';
  if (seconds <= 3600) return 'Hourly';
  if (seconds <= 86400) return 'Daily';
  if (seconds <= 604800) return 'Weekly';
  return 'Monthly';
}

function collectWindows(
  rateLimit: WhamRateLimit | undefined | null,
  prefix = '',
): QuotaWindow[] {
  const results: QuotaWindow[] = [];

  const add = (label: string, w: WhamWindow | undefined | null) => {
    if (!w) return;
    results.push({
      label: prefix ? `${prefix} ${label}` : label,
      percent: w.used_percent,
      resetAt: unixToISO(w.reset_at),
      windowLabel: windowLabelFromSeconds(w.limit_window_seconds),
    });
  };

  add('Primary', rateLimit?.primary_window);
  add('Secondary', rateLimit?.secondary_window);

  return results;
}

// ── Main fetch ──

export async function fetchCodexQuota(): Promise<QuotaResult> {
  const tokens = discoverCodexTokens();
  const result: QuotaResult = {
    slug: 'codex',
    displayName: 'Codex',
    usagePercent: 0,
    windows: [],
    fetchedAt: Date.now(),
  };

  if (tokens.length === 0) {
    result.error = 'No token found';
    return result;
  }

  for (const t of tokens) {
    // Strategy 1: wham endpoint (ChatGPT Plus/Pro subscription)
    try {
      const wham = await fetchWham(t.token);
      if (wham) {
        const windows: QuotaWindow[] = [];
        let worstPct = 0;

        // Main rate limit
        windows.push(...collectWindows(wham.rate_limit));

        // Code review rate limit (separate quota for code review feature)
        windows.push(...collectWindows(wham.code_review_rate_limit, 'Review'));

        // Additional rate limits (GPT-5, image gen, etc.)
        if (wham.additional_rate_limits) {
          for (const [kind, rl] of Object.entries(wham.additional_rate_limits)) {
            if (rl && (rl.primary_window || rl.secondary_window)) {
              windows.push(...collectWindows(rl, kind));
            }
          }
        }

        if (windows.length > 0) {
          for (const w of windows) {
            if (w.percent > worstPct) worstPct = w.percent;
          }

          // Add plan type / credit info as context
          if (wham.plan_type) {
            const planLabel = wham.plan_type === 'plus' ? 'ChatGPT Plus'
              : wham.plan_type === 'pro' ? 'ChatGPT Pro'
              : wham.plan_type === 'free' ? 'ChatGPT Free'
              : wham.plan_type;
            // Prepend plan as first window entry
            windows.unshift({
              label: planLabel,
              percent: 0,
              windowLabel: wham.credits?.unlimited ? 'unlimited' : undefined,
            });
          }

          result.windows = windows;
          result.usagePercent = Math.round(worstPct);
          result.remaining = Math.max(0, 100 - worstPct);
          result.entitlement = 100;

          // Use primary reset time
          if (wham.rate_limit?.primary_window?.reset_at) {
            result.resetAt = unixToISO(wham.rate_limit.primary_window.reset_at);
          }

          return result;
        }
      }
    } catch {
      // Fall through to next strategy
    }

    // Strategy 2: API billing endpoint
    try {
      const usageTokens = await fetchApiBilling(t.token);
      if (usageTokens !== null) {
        result.windows = [{
          label: 'API Usage',
          percent: 0,
          windowLabel: usageTokens >= 1_000_000
            ? `${(usageTokens / 1_000_000).toFixed(1)}M tokens`
            : `${usageTokens.toLocaleString()} tokens`,
        }];
        return result;
      }
    } catch {
      // Continue
    }
  }

  result.error = 'Unable to fetch Codex quota. If you use ChatGPT Plus, login via Codex CLI (`codex login`).';
  return result;
}

export function isCodexAvailable(): boolean {
  return discoverCodexTokens().length > 0;
}
