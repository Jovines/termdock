import { ChevronRight, History, LayoutGrid, RefreshCw, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { getCwdLeafName } from '../../terminal/display';
import type { TmuxSessionSummary } from '../../terminal/types';
import { LoadingSpinner } from '../ui/Loading';

const COLLAPSE_KEY = 'recoverable-tmux';

export function RecoverableSessions({ sessions, loading, attachingName, onRefresh, onRestore, onClose }: {
  sessions: TmuxSessionSummary[];
  loading: boolean;
  attachingName: string | null;
  onRefresh?: () => void;
  onRestore: (session: TmuxSessionSummary) => void;
  onClose?: (name: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const collapsed = useSidebarStore(state => state.collapsedGroups.has(COLLAPSE_KEY));
  const toggleCollapsed = useSidebarStore(state => state.toggleGroupCollapsed);
  const [confirmingName, setConfirmingName] = useState<string | null>(null);
  const [closingName, setClosingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closing = useRef(false);

  const closeSession = async (name: string) => {
    if (!onClose || closing.current) return;
    closing.current = true;
    setClosingName(name);
    setError(null);
    try {
      await onClose(name);
      setConfirmingName(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : t('sidebar.closeRecoverableSessionFailed'));
    } finally {
      closing.current = false;
      setClosingName(null);
    }
  };

  if (sessions.length === 0) return null;

  return (
    <section className="mb-2 shrink-0 rounded-lg bg-[rgb(var(--tmux-rgb)_/_0.07)] p-1" aria-label={t('sidebar.recoverableSessions')}>
      <div className="flex items-center gap-1 text-[10.5px] font-semibold text-[color:var(--tmux)]">
        <button type="button" aria-expanded={!collapsed} onClick={() => toggleCollapsed(COLLAPSE_KEY)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left hover:bg-surface-elevated md:min-h-8">
          <ChevronRight size={12} className={`shrink-0 ${collapsed ? '' : 'rotate-90'}`} />
          <History size={12} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t('sidebar.recoverableSessions')}</span>
          <span className="text-muted-foreground">{sessions.length}</span>
        </button>
        {onRefresh && <button type="button" onClick={onRefresh} disabled={loading || closingName !== null}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground disabled:opacity-50 md:h-7 md:w-7"
          aria-label={t('sidebar.refreshRecoverableSessions')} title={t('sidebar.refreshRecoverableSessions')}>
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>}
      </div>
      {!collapsed && <div className="space-y-0.5">
        {sessions.map(session => {
          const title = session.friendlyName?.trim() || session.label?.trim() || session.name;
          const directory = getCwdLeafName(session.cwd ?? null);
          const attaching = attachingName === session.name;
          const confirming = confirmingName === session.name;
          return (
            <div key={session.name}>
              <div className="flex min-w-0 items-center">
                <button type="button" disabled={attachingName !== null || closingName !== null || confirming}
                  onClick={() => onRestore(session)}
                  className="group flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-muted-foreground transition hover:bg-surface-elevated hover:text-foreground disabled:opacity-60 md:min-h-10"
                  aria-label={t('sidebar.restoreRecoverableSession', { name: title })} title={session.cwd || session.name}>
                  <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[rgb(var(--tmux-rgb)_/_0.11)] text-[color:var(--tmux)]">
                    {attaching ? <LoadingSpinner size={12} className="animate-spin" /> : <LayoutGrid size={12} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] font-semibold text-foreground">{title}</span>
                    <span className="block truncate text-[9.5px] text-muted-foreground">
                      {[session.program, directory].filter(Boolean).join(' · ') || `tmux:${session.name}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] font-medium text-[color:var(--tmux)] group-hover:text-foreground">
                    {attaching ? t('sidebar.restoringRecoverableSession') : t('sidebar.restore')}
                  </span>
                </button>
                {onClose && <button type="button" disabled={attachingName !== null || closingName !== null}
                  onClick={() => { setConfirmingName(session.name); setError(null); }}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-destructive/15 hover:text-destructive disabled:opacity-50 md:h-7 md:w-7"
                  aria-label={t('sidebar.closeSession', { name: title })} title={t('sidebar.closeSession', { name: title })}>
                  <X size={12} />
                </button>}
              </div>
              {confirming && <div role="group" aria-label={t('sidebar.closeSession', { name: title })} className="space-y-2 rounded-md bg-surface px-2 py-2">
                <p className="text-[11px] text-foreground">{t('sidebar.confirmCloseRecoverableSession', { name: title })}</p>
                {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
                <div className="flex justify-end gap-2">
                  <button type="button" disabled={closingName !== null} onClick={() => { setConfirmingName(null); setError(null); }}
                    className="min-h-11 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-surface-elevated disabled:opacity-50 md:min-h-8">{t('common.cancel')}</button>
                  <button type="button" disabled={closingName !== null} onClick={() => void closeSession(session.name)}
                    className="min-h-11 rounded-md bg-destructive/15 px-2 text-[11px] text-destructive hover:bg-destructive/25 disabled:opacity-50 md:min-h-8">
                    {closingName === session.name ? t('common.loading') : t('sidebar.endRecoverableSession')}
                  </button>
                </div>
              </div>}
            </div>
          );
        })}
      </div>}
    </section>
  );
}
