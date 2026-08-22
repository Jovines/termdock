import { RefreshCw as RiRefreshLine } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { DesktopAppUpdateState } from '../../desktop/nativeBridge';
import type { TermdockUpdateState } from '../../terminal/api';

interface TermdockUpdateSettingsProps {
  state: TermdockUpdateState | null;
  pending: boolean;
  onCheck: () => void;
  onConfirmRestart: () => void;
  desktopState?: DesktopAppUpdateState | null;
  desktopPending?: boolean;
  onCheckDesktop?: () => void;
  onInstallDesktop?: () => void;
}

export function TermdockUpdateSettings({
  state,
  pending,
  onCheck,
  onConfirmRestart,
  desktopState,
  desktopPending = false,
  onCheckDesktop,
  onInstallDesktop,
}: TermdockUpdateSettingsProps) {
  const { t } = useI18n();
  const status = state?.status ?? 'idle';
  const busy = pending || status === 'checking' || status === 'installing' || status === 'restarting';
  const ready = status === 'ready' && Boolean(state?.latestVersion);
  const statusText = status === 'checking'
    ? t('settings.updateChecking')
    : status === 'installing'
      ? t('sidebar.updateInstalling')
      : status === 'ready'
        ? t('sidebar.updateReady')
        : status === 'restarting'
          ? t('sidebar.updateRestarting')
          : status === 'current'
            ? t('settings.updateCurrent')
            : status === 'error'
              ? (state?.error || t('sidebar.updateFailed'))
              : t('settings.updateHint');
  const desktopStatus = desktopState?.status ?? 'idle';
  const desktopBusy = desktopPending || desktopStatus === 'checking' || desktopStatus === 'downloading' || desktopStatus === 'installing';
  const desktopReady = desktopStatus === 'ready';
  const desktopStatusText = desktopStatus === 'unsupported'
    ? t('settings.desktopUpdateUnsupported')
    : desktopStatus === 'checking'
      ? t('settings.desktopUpdateChecking')
      : desktopStatus === 'current'
        ? t('settings.desktopUpdateCurrent')
        : desktopStatus === 'downloading'
          ? t('settings.desktopUpdateDownloading')
          : desktopStatus === 'ready'
            ? t('settings.desktopUpdateReady')
            : desktopStatus === 'installing'
              ? t('settings.desktopUpdateInstalling')
              : desktopStatus === 'error'
                ? (desktopState?.error || t('settings.desktopUpdateHint'))
                : t('settings.desktopUpdateHint');

  return (
    <section className="mt-3 overflow-hidden rounded-xl bg-surface-2" aria-labelledby="termdock-update-title">
      <div id="termdock-update-title" className="px-3 pt-3 text-[12px] font-semibold text-foreground">
        {t('settings.updateTitle')}
      </div>
      <div className="flex items-start justify-between gap-3 px-3 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${ready ? 'bg-[rgb(var(--warning-rgb)_/_0.16)] text-[color:var(--warning)]' : 'bg-primary/15 text-primary'}`}>
            <RiRefreshLine size={15} className={busy ? 'animate-spin' : ''} />
          </span>
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-foreground">
              {t('settings.updateRuntimeTitle')}
            </div>
            <div className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{statusText}</div>
            {state && (
              <div className="mt-1 text-[10px] tabular-nums text-muted-foreground/75">
                {ready && state.latestVersion ? `${state.currentVersion} → ${state.latestVersion}` : `v${state.currentVersion}`}
              </div>
            )}
          </div>
        </div>
        {ready ? (
          <button
            type="button"
            disabled={busy}
            onClick={onConfirmRestart}
            className="shrink-0 rounded-full bg-[var(--warning)] px-3 py-1.5 text-[11px] font-semibold text-[color:var(--bg)] transition hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
          >
            {t('sidebar.updateRestart')}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={onCheck}
            className="shrink-0 rounded-full bg-surface px-3 py-1.5 text-[11px] font-medium text-foreground transition hover:bg-surface-elevated disabled:cursor-wait disabled:opacity-60"
          >
            {status === 'checking'
              ? t('settings.updateCheckingShort')
              : status === 'installing'
                ? t('settings.updateInstallingShort')
                : status === 'error'
                  ? t('sidebar.updateRetry')
                  : status === 'current'
                    ? t('settings.updateCheckAgain')
                    : t('settings.updateCheck')}
          </button>
        )}
      </div>
      {desktopState && (
        <div className="flex items-start justify-between gap-3 border-t border-border/10 px-3 py-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${desktopReady ? 'bg-[rgb(var(--warning-rgb)_/_0.16)] text-[color:var(--warning)]' : 'bg-primary/15 text-primary'}`}>
              <RiRefreshLine size={15} className={desktopBusy ? 'animate-spin' : ''} />
            </span>
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-foreground">{t('settings.desktopUpdateTitle')}</div>
              <div className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{desktopStatusText}</div>
              <div className="mt-1 text-[10px] tabular-nums text-muted-foreground/75">
                {desktopReady && desktopState.latestVersion
                  ? `${desktopState.currentVersion} → ${desktopState.latestVersion}`
                  : `v${desktopState.currentVersion}`}
              </div>
            </div>
          </div>
          {desktopReady ? (
            <button
              type="button"
              disabled={desktopBusy || !onInstallDesktop}
              onClick={onInstallDesktop}
              className="shrink-0 rounded-full bg-[var(--warning)] px-3 py-1.5 text-[11px] font-semibold text-[color:var(--bg)] transition hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
            >
              {t('settings.desktopUpdateRestart')}
            </button>
          ) : (
            <button
              type="button"
              disabled={desktopBusy || desktopStatus === 'unsupported' || !onCheckDesktop}
              onClick={onCheckDesktop}
              className="shrink-0 rounded-full bg-surface px-3 py-1.5 text-[11px] font-medium text-foreground transition hover:bg-surface-elevated disabled:cursor-wait disabled:opacity-60"
            >
              {desktopStatus === 'checking'
                ? t('settings.updateCheckingShort')
                : desktopStatus === 'current' || desktopStatus === 'error'
                  ? t('settings.desktopUpdateCheckAgain')
                  : t('settings.desktopUpdateCheck')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
