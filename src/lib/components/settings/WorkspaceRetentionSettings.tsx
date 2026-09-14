import { useId, useSyncExternalStore } from 'react';
import { useI18n } from '../../i18n';
import { getWorkspaceHost } from '../../services/workspaceHost';
import { MAX_FINITE_WORKSPACE_LIMIT } from '../../services/workspaceRetention';

const subscribeEmpty = () => () => {};
const unlimited = () => Infinity;

export function WorkspaceRetentionSettings() {
  const { t } = useI18n();
  const id = useId();
  const host = getWorkspaceHost();
  const limit = useSyncExternalStore(host?.subscribe ?? subscribeEmpty, host?.retentionLimit ?? unlimited);
  if (!host) return null;
  const lastStep = MAX_FINITE_WORKSPACE_LIMIT + 1;
  const label = limit === Infinity ? t('settings.workspaceUnlimited') : String(limit);
  return <div className="space-y-1.5 rounded-xl bg-surface-2 px-2.5 py-2">
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="shrink-0 text-[12px] font-medium text-foreground/90">{t('settings.workspaceLimit')}</label>
      <input id={id} type="range" min={3} max={lastStep} step={1}
        value={limit === Infinity ? lastStep : limit}
        aria-valuetext={label} aria-describedby={`${id}-hint`}
        onChange={event => {
          const value = Number(event.target.value);
          host.setRetentionLimit(value === lastStep ? Infinity : value);
        }}
        className="h-8 min-w-0 flex-1" />
      <output htmlFor={id} className="min-w-12 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{label}</output>
    </div>
    <p id={`${id}-hint`} className="text-[11px] leading-relaxed text-muted-foreground">{t('settings.workspaceLimitHint')}</p>
  </div>;
}
