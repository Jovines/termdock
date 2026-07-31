/**
 * QuotaView — modal panel showing all AI subscription plan quotas.
 */

import React, { useEffect, useState } from 'react';
import { X as RiCloseLine, RefreshCw as RiRefreshLine } from 'lucide-react';
import { fetchQuota, refreshQuota, type QuotaResult, type QuotaWindow } from '../../terminal/api';
import { useI18n } from '../../i18n';

// ── Helpers ──

function barColor(pct: number): string {
  if (pct >= 90) return 'var(--destructive)';
  if (pct >= 70) return 'var(--warning)';
  return 'var(--success)';
}

function barBg(pct: number): string {
  if (pct >= 90) return 'var(--destructive)/0.15';
  if (pct >= 70) return 'var(--warning)/0.15';
  return 'var(--success)/0.12';
}

function formatReset(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = d.getTime() - now;
  if (diffMs <= 0) return '';
  const totalMinutes = Math.floor(diffMs / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  const absDate = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const absTime = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  let relative: string;
  if (days > 0) relative = `${days}d ${hours}h`;
  else if (hours > 0) relative = `${hours}h ${minutes}m`;
  else if (minutes > 0) relative = `${minutes}m`;
  else relative = 'soon';

  return `resets in ${relative} (${absDate} ${absTime})`;
}

function providerIcon(slug: string): string {
  const map: Record<string, string> = {
    claude: '\u{1F9E0}', codex: '✨', kimi: '\u{1F319}', copilot: '\u{1F419}', grok: '\u{1F680}', gemini: '\u{1F48E}',
  };
  return map[slug] || '\u{1F4CA}';
}

// ── Provider Card ──

function ProviderCard({ result }: { result: QuotaResult }): React.ReactElement {
  const { t } = useI18n();
  const infoWindows = result.windows.filter((w) => w.percent === 0 && !w.resetAt);
  const quotaWindows = result.windows.filter((w) => w.percent > 0 || w.resetAt);
  const planLabel = infoWindows.length > 0 ? infoWindows.map((w) => w.label).join(' · ') : '';
  const hasError = !!result.error;

  let summary: string | null = null;
  if (!hasError && result.entitlement) {
    if (result.usagePercent >= 90) summary = t('quota.exhausted');
    else if (result.remaining !== undefined && result.remaining < result.entitlement) summary = t('quota.left', { n: result.remaining });
    else summary = `${Math.round(result.usagePercent)}%`;
  }

  return (
    <div className="rounded-xl border border-border/15 bg-surface-2 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-foreground">
          <span className="shrink-0">{providerIcon(result.slug)}</span>
          <span className="truncate">{result.displayName}</span>
          {planLabel && (
            <span className="shrink-0 rounded-full bg-surface-elevated px-2 py-0.5 text-[10px] font-normal text-muted-foreground">
              {planLabel}
            </span>
          )}
        </span>
        {summary && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {summary}
          </span>
        )}
      </div>

      {quotaWindows.length > 0 ? (
        <div className="mt-2.5 space-y-2">
          {quotaWindows.map((w: QuotaWindow) => {
            const clamped = Math.max(0, Math.min(100, w.percent));
            return (
              <div key={w.label}>
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="w-14 shrink-0 truncate text-muted-foreground sm:w-16">
                    {w.label}
                  </span>
                  <div className="flex-1">
                    <div className="h-2 rounded-full" style={{ background: barBg(w.percent) }}>
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${clamped}%`, background: barColor(w.percent) }}
                      />
                    </div>
                  </div>
                  <span className="w-9 shrink-0 text-right tabular-nums font-medium text-foreground">
                    {Math.round(w.percent)}%
                  </span>
                </div>
                {w.resetAt && (
                  <p className="mt-1 pl-14 text-[10px] text-muted-foreground sm:pl-16">
                    {formatReset(w.resetAt)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ) : hasError ? (
        <p className="mt-2 text-[11px] text-muted-foreground">{result.error}</p>
      ) : null}
    </div>
  );
}

// ── QuotaView (Modal) ──

export interface QuotaViewProps {
  isOpen: boolean;
  onClose: () => void;
}

export function QuotaView({ isOpen, onClose }: QuotaViewProps): React.ReactElement | null {
  const { t } = useI18n();
  const [providers, setProviders] = useState<QuotaResult[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async (force = false) => {
    setLoading(true);
    try {
      const data = force ? await refreshQuota() : await fetchQuota();
      setProviders(data.providers || []);
    } catch {
      // Keep stale data.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) { load(); }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onQuota = (e: Event) => {
      const detail = (e as CustomEvent<QuotaResult[]>).detail;
      if (Array.isArray(detail)) { setProviders(detail); }
    };
    window.addEventListener('termdock:quota-update', onQuota);
    return () => { window.removeEventListener('termdock:quota-update', onQuota); };
  }, [isOpen]);

  if (!isOpen) return null;

  const updatedAt = providers.length > 0
    ? new Date(Math.max(...providers.map((p) => p.fetchedAt || 0)))
    : null;

  return (
    <>
      <button type="button" className="fixed inset-0 z-modal-backdrop bg-[var(--app-backdrop)] backdrop-blur-sm cursor-default" onClick={onClose} />
      <div
        className="fixed inset-x-3 z-modal-panel mx-auto flex max-w-lg flex-col overflow-hidden rounded-2xl bg-surface border border-border/15 shadow-[0_28px_70px_var(--app-shadow-strong),0_14px_32px_var(--app-shadow-soft)]"
        style={{
          top: 'max(1.5rem, env(safe-area-inset-top, 0px))',
          bottom: 'max(1.5rem, env(safe-area-inset-bottom, 0px))',
        }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border/15 px-3 py-2.5 sm:px-6 sm:py-3">
          <h2 className="text-[14px] font-semibold text-foreground sm:text-base">{t('quota.title')}</h2>
          <div className="flex items-center gap-1.5">
            <button
              type="button" onClick={() => load(true)} disabled={loading}
              className="shrink-0 rounded-full bg-surface-2 p-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground disabled:opacity-50"
              aria-label={t('quota.refresh')}
            >
              <RiRefreshLine size={15} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              type="button" onClick={onClose}
              className="shrink-0 rounded-full bg-surface-2 p-2 text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground"
              aria-label={t('quota.close')}
            >
              <RiCloseLine size={17} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
          {loading && providers.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <RiRefreshLine size={24} className="animate-spin text-muted-foreground" />
            </div>
          ) : providers.length === 0 ? (
            <div className="py-8 text-center text-[13px] text-muted-foreground">
              <p>{t('quota.noProviders')}</p>
              <p className="mt-1.5 text-[11px]">{t('quota.noProvidersHint')}</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {providers.map((p) => (
                <ProviderCard key={p.slug} result={p} />
              ))}
            </div>
          )}

          {updatedAt && (
            <p className="mt-3 text-center text-[10px] text-muted-foreground">
              {t('quota.updated', { time: updatedAt.toLocaleTimeString() })}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
