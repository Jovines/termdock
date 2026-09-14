import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { BellDot, ChevronRight, X } from 'lucide-react';
import { useI18n } from '../i18n';
import { getWorkspaceHost, workspaceKey, type ServiceWorkspace, type WorkspaceSnapshot } from '../services/workspaceHost';

const empty: WorkspaceSnapshot = { activeKey: 'root', items: [] };
const emptySubscribe = () => () => {};
const emptySnapshot = () => empty;

export function useServiceAttention(localCount: number) {
  const host = getWorkspaceHost();
  const snapshot = useSyncExternalStore(host?.subscribe ?? emptySubscribe, host?.snapshot ?? emptySnapshot);
  const currentKey = workspaceKey();
  // Local counts may render before the activity-report effect. Do not count
  // that workspace twice or temporarily resurrect its cleared badge.
  const groups = snapshot.items.map(item => item.key === currentKey ? { ...item, reviewCount: localCount } : item)
    .filter(item => item.reviewCount > 0);
  return {
    host, groups, currentKey,
    active: !host || snapshot.activeKey === currentKey,
    total: host ? localCount + groups.reduce((sum, item) => sum + (item.key === currentKey ? 0 : item.reviewCount), 0) : localCount,
    hasOtherAttention: groups.some(item => item.key !== currentKey),
  };
}

export function ServiceAttentionDialog({ groups, currentKey, onClose }: {
  groups: readonly ServiceWorkspace[];
  currentKey: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const restoreFocus = useRef(true);
  const [error, setError] = useState('');
  const total = groups.reduce((sum, group) => sum + group.reviewCount, 0);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const first = buttons[0], last = buttons[buttons.length - 1];
      const outside = !dialog.current?.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || outside)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || outside)) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      if (restoreFocus.current && previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, []);

  const choose = (group: ServiceWorkspace, sessionId?: string) => {
    const host = getWorkspaceHost();
    const latest = host?.snapshot().items.find(item => item.key === group.key);
    if (!latest?.reviewCount || (sessionId && !latest.attentionSessions?.some(session => session.id === sessionId))) {
      setError(t('serviceAttention.changed')); return;
    }
    // Browsing and closing this list never acknowledge a notification. Only
    // the selected session uses the existing notification-focus path.
    restoreFocus.current = false;
    let opened = false;
    if (sessionId && group.key === currentKey) {
      window.dispatchEvent(new CustomEvent('termdock:focus-session', { detail: sessionId }));
      opened = true;
    } else if (sessionId && latest.service?.targetPeerId) {
      opened = host?.focusSession(latest.service.targetPeerId, sessionId) ?? false;
    } else if (latest.service) {
      opened = host?.activate(latest.service, true) ?? false;
    }
    if (opened) onClose();
    else { restoreFocus.current = true; setError(t('serviceAttention.unavailable')); }
  };

  const connectionLabel = (group: ServiceWorkspace) => group.phase === 'offline' ? t('serviceAttention.offline')
    : group.phase === 'login' ? t('serviceAttention.login')
    : group.phase === 'connecting' || group.phase === 'reconnecting' ? t('connection.reconnecting') : null;

  return <>
    <button type="button" aria-label={t('common.close')} tabIndex={-1}
      className="fixed inset-0 z-modal-backdrop cursor-default bg-[var(--app-backdrop)]"
      onClick={onClose} />
    <div className="pointer-events-none fixed inset-0 z-modal-panel flex items-end justify-center p-3 sm:items-center sm:p-6"
      style={{ paddingTop: 'max(12px, var(--safe-top-inset, env(safe-area-inset-top, 0px)))', paddingBottom: 'max(12px, var(--safe-bottom-inset, env(safe-area-inset-bottom, 0px)))' }}>
      <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} data-sidebar-gesture-ignore
        onKeyDown={event => event.stopPropagation()}
        className="pointer-events-auto flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-surface text-foreground shadow-xl">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
          <BellDot size={20} className="shrink-0 text-[color:var(--warning)]" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-sm font-semibold">{t('serviceAttention.title')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('serviceAttention.summary', { services: groups.length, count: total })}</p>
          </div>
          <button ref={closeButton} type="button" aria-label={t('common.close')} onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><X size={18} /></button>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-2">
          {groups.length === 0 && <p role="status" className="px-4 py-8 text-center text-sm text-muted-foreground">{t('serviceAttention.empty')}</p>}
          {groups.map(group => <section key={group.key} className="mb-2 last:mb-0">
            <div className="flex min-w-0 items-center gap-2 px-3 pb-1 pt-2 text-xs">
              <h3 className="min-w-0 flex-1 truncate font-medium" title={group.service?.label}>{group.service?.label || t('serviceAttention.currentService')}</h3>
              {group.key === currentKey && <span className="shrink-0 text-muted-foreground">{t('agent.currentSession')}</span>}
              <span className="shrink-0 tabular-nums text-[color:var(--warning)]">{group.reviewCount}</span>
            </div>
            {connectionLabel(group) && <p className="px-3 pb-1 text-xs text-[color:var(--warning)]">{connectionLabel(group)}</p>}
            {group.attentionSessions?.length ? group.attentionSessions.map(session => <button key={session.id} type="button" onClick={() => choose(group, session.id)}
              className="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
              <div className="min-w-0 flex-1"><span className="line-clamp-2 break-words text-sm" title={session.label}>{session.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{session.waiting ? t('serviceAttention.waiting') : t('agent.needsReview')}</span></div>
              <ChevronRight size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>) : <button type="button" onClick={() => choose(group)}
              className="min-h-11 w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">{t('serviceAttention.viewService')}</button>}
          </section>)}
        </div>
        <footer className="shrink-0 border-t border-border px-4 py-3 text-xs text-muted-foreground">
          {error && <p role="alert" className="mb-1 text-[color:var(--warning)]">{error}</p>}
          {t('serviceAttention.scope')}
        </footer>
      </section>
    </div>
  </>;
}
