import { ShieldAlert as RiShieldAlertLine, ShieldCheck as RiShieldCheckLine } from 'lucide-react';
import { useI18n, type TranslationKey } from '../../i18n';
import type { ServerHealthState } from '../../terminal/api';

interface ServerHealthSettingsProps {
  state: ServerHealthState | null;
  onDismiss: () => void;
}

/**
 * 事件名 → 文案。表里没有的事件（服务端将来加了新的）退到 `serverHealthUnknownEvent`，
 * 并照原样把技术细节显示在副标题里——宁可是英文的机器话，也不要假装无事发生。
 */
const EVENT_KEYS: Record<string, TranslationKey> = {
  'startup-failure': 'settings.serverHealthEventStartupFailure',
  'crash': 'settings.serverHealthEventCrash',
  'crash-native': 'settings.serverHealthEventCrashNative',
  'killed': 'settings.serverHealthEventKilled',
  'wedge': 'settings.serverHealthEventWedge',
  'port-conflict': 'settings.serverHealthEventPortConflict',
  'gave-up': 'settings.serverHealthEventGaveUp',
  'exit-zero-unexpected': 'settings.serverHealthEventExitZero',
  'terminated-externally': 'settings.serverHealthEventTerminated',
  'supervisor-lost': 'settings.serverHealthEventSupervisorLost',
  'uncaught-exception': 'settings.serverHealthEventUncaughtException',
  'unhandled-rejection': 'settings.serverHealthEventUnhandledRejection',
  'exit-nonzero': 'settings.serverHealthEventExitNonzero',
};

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export function ServerHealthSettings({ state, onDismiss }: ServerHealthSettingsProps) {
  const { t } = useI18n();
  // 快照还没到（首屏、或服务刚重启）时不显示"一切正常"——那会是一句没有依据的话。
  if (!state) return null;

  const incident = state.incident;
  const gaveUp = state.supervisor?.phase === 'gave-up';
  const supervisorLost = state.supervisor !== null && !state.supervisor.alive;
  const problem = gaveUp || supervisorLost || Boolean(incident?.event);

  // 监督状态那一行说清"下次它挂了会怎样"，这是红点背后最要紧的一句话。
  const supervisionText = gaveUp
    ? t('settings.serverHealthGaveUp', { count: state.supervisor?.consecutiveCrashes ?? 0 })
    : supervisorLost
      ? t('settings.serverHealthSupervisorLost')
      : state.supervised
        ? t('settings.serverHealthSupervised')
        : t('settings.serverHealthUnsupervised');

  const eventLabel = incident
    ? t(EVENT_KEYS[incident.event] ?? 'settings.serverHealthUnknownEvent')
    : '';
  const timing = incident
    ? [
      new Date(incident.at).toLocaleString(),
      incident.uptimeMs !== null ? t('settings.serverHealthUptime', { duration: formatDuration(incident.uptimeMs) }) : null,
      incident.signal ? `signal ${incident.signal}` : null,
      incident.exitCode !== null ? `exit ${incident.exitCode}` : null,
    ].filter(Boolean).join(' · ')
    : '';

  return (
    <section className="mt-3 overflow-hidden rounded-xl bg-surface-2" aria-labelledby="server-health-title">
      <div id="server-health-title" className="px-3 pt-3 text-[12px] font-semibold text-foreground">
        {t('settings.serverHealthTitle')}
      </div>
      <div className="flex items-start justify-between gap-3 px-3 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${problem ? 'bg-destructive/15 text-destructive' : 'bg-primary/15 text-primary'}`}>
            {problem ? <RiShieldAlertLine size={15} /> : <RiShieldCheckLine size={15} />}
          </span>
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-foreground">{supervisionText}</div>
            <div className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
              {incident ? `${t('settings.serverHealthLastIncident')}: ${eventLabel}` : t('settings.serverHealthClean')}
            </div>
            {incident && (
              <div className="mt-1 text-[10px] tabular-nums text-muted-foreground/75">{timing}</div>
            )}
            {incident?.detail && (
              <div className="mt-1 break-words text-[10px] text-muted-foreground/75">{incident.detail}</div>
            )}
            {incident?.oomSuspect && (
              <div className="mt-1 text-[10px] text-[color:var(--warning)]">{t('settings.serverHealthOomNote')}</div>
            )}
            {state.supervisor && state.supervisor.restarts > 0 && !gaveUp && (
              <div className="mt-1 text-[10px] tabular-nums text-muted-foreground/75">
                {t('settings.serverHealthRestarted', { count: state.supervisor.restarts })}
              </div>
            )}
          </div>
        </div>
        {state.attention && (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded-full bg-surface px-3 py-1.5 text-[11px] font-medium text-foreground transition hover:bg-surface-elevated"
          >
            {t('settings.serverHealthDismiss')}
          </button>
        )}
      </div>
    </section>
  );
}
