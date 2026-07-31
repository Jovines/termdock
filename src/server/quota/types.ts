/**
 * Subscription quota tracking types.
 *
 * Each provider's fetch() returns a QuotaResult with usage percentage,
 * remaining/entitlement for quota-based plans, and optional per-window
 * breakdowns (e.g. Claude's 5h/7d windows, Codex's primary/secondary).
 */

export interface QuotaWindow {
  label: string;
  /** Usage percentage 0-100. >100 means over limit. */
  percent: number;
  /** ISO-8601 reset time, if known. */
  resetAt?: string;
  /** Human-readable window label from the API (e.g. "7-day", "Hourly"). */
  windowLabel?: string;
}

export interface QuotaResult {
  slug: string;
  displayName: string;
  /** Top-level usage percentage (worst window for quota-based, utilization for PAYG). */
  usagePercent: number;
  /** Only for quota-based plans. */
  remaining?: number;
  /** Only for quota-based plans. */
  entitlement?: number;
  /** ISO-8601 reset time for the primary window. */
  resetAt?: string;
  /** Per-window detail (Claude: 5h/7d/Sonnet/Opus/Fable, Codex: primary/secondary/spark). */
  windows: QuotaWindow[];
  /** Error message if fetch failed. */
  error?: string;
  /** When this result was fetched (ms since epoch). */
  fetchedAt: number;
}

export interface QuotaStatus {
  providers: QuotaResult[];
  updatedAt: number;
}

/** Wire payload sent via WS and SSE. */
export interface QuotaStatusWirePayload {
  type: 'quota-status';
  providers: QuotaResult[];
  updatedAt: number;
}

export interface QuotaProvider {
  slug: string;
  displayName: string;
  /** Whether this provider can be used (token found, configured). */
  isAvailable(): boolean;
  /** Fetch current quota from the provider API. */
  fetch(): Promise<QuotaResult>;
}
