import { useEffect, useRef, useState } from 'react';
import { LayoutGrid, LogOut, RefreshCw } from 'lucide-react';
import { currentSecureClient, savedConnection } from '../../federation/browserIntegration';
import { useI18n } from '../../i18n';
import { useSessionOrderStore } from '../../stores/useSessionOrderStore';
import { saveCollaborationGroup, type CollaborationGroup } from '../../terminal/api';

/** Session menus edit membership only; the terminal and group history survive. */
export function SessionCollaborationActions({ sessionId, backendSessionId, groupId, itemClassName, iconClassName, compact = false, onOpen, onDone }: {
  sessionId: string; backendSessionId?: string | null; groupId?: string;
  itemClassName: string; iconClassName: string; compact?: boolean;
  onOpen: (groupId: string) => void; onDone: () => void;
}) {
  const { t } = useI18n();
  const groups = useSessionOrderStore(state => state.collaborationGroups);
  const [confirmation, setConfirmation] = useState<CollaborationGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  const confirmRef = useRef<HTMLDivElement>(null);
  const leaveButtons = useRef(new Map<string, HTMLButtonElement>());
  const isMember = (id: string) => id === sessionId || id === backendSessionId;
  const memberships = groups.filter(group => (!groupId || group.id === groupId) && group.sessionIds.some(isMember));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (confirmation) confirmRef.current?.querySelector('button')?.focus({ preventScroll: true });
  }, [confirmation]);
  useEffect(() => { if (confirmation) confirmRef.current?.scrollIntoView({ block: 'nearest' }); }, [confirmation, error]);

  const leave = async () => {
    if (!confirmation || pending.current) return;
    const snapshot = confirmation;
    const client = currentSecureClient();
    const peerId = savedConnection()?.targetPeerId;
    const current = () => currentSecureClient() === client && savedConnection()?.targetPeerId === peerId;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await saveCollaborationGroup({ id: snapshot.id, name: snapshot.name,
        sessionIds: snapshot.sessionIds.filter(id => !isMember(id)), expectedUpdatedAt: snapshot.updatedAt });
      if (!current()) return;
      useSessionOrderStore.getState().setCollaborationGroups(previous => previous.map(group =>
        group.id === result.group.id && group.updatedAt <= result.group.updatedAt ? result.group : group));
      if (mounted.current) onDone();
    } catch (cause) {
      if (mounted.current && current()) setError(cause instanceof Error ? cause.message : t('tab.leaveGroupFailed'));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return <>{memberships.map(group => <div key={group.id} className="border-t border-border/15 py-1">
    <button type="button" disabled={busy} className={`${itemClassName} w-full text-foreground hover:bg-surface-2 disabled:opacity-50`}
      onClick={() => onOpen(group.id)}>
      <span className={`${iconClassName} bg-primary/15 text-primary`}><LayoutGrid size={14} /></span>
      <span className={`min-w-0 flex-1 ${compact ? 'flex items-center gap-2' : ''}`}><span className="block shrink-0 font-medium">{t('tab.openGroup')}</span><span className="block truncate text-[11px] text-muted-foreground" title={group.name}>{group.name}</span></span>
    </button>
    {confirmation?.id === group.id ? <div ref={confirmRef} role="group" aria-label={t('tab.leaveGroupConfirm')} aria-busy={busy} className="mx-3 my-1 rounded-lg border border-border/30 bg-surface p-3">
      <p className="break-words text-xs leading-5 text-foreground">{t('tab.leaveGroupQuestion', { name: confirmation.name })}</p>
      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{t('tab.leaveGroupHint')}</p>
      {error && <p role="alert" className="mt-2 break-words text-xs leading-5 text-destructive">{error}</p>}
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <button type="button" disabled={busy} className="min-h-11 rounded-lg bg-surface-2 px-3 text-xs text-foreground disabled:opacity-50" onClick={() => {
          setConfirmation(null); setError('');
          queueMicrotask(() => leaveButtons.current.get(group.id)?.focus({ preventScroll: true }));
        }}>{t('common.cancel')}</button>
        <button type="button" disabled={busy} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-3 text-xs text-primary-foreground disabled:opacity-50" onClick={() => void leave()}>{busy && <RefreshCw size={14} className="animate-spin" />}{t(busy ? 'tab.leavingGroup' : 'tab.leaveGroupConfirm')}</button>
      </div>
    </div> : <button type="button" ref={element => { if (element) leaveButtons.current.set(group.id, element); else leaveButtons.current.delete(group.id); }} disabled={busy} className={`${itemClassName} w-full text-foreground hover:bg-surface-2 disabled:opacity-50`}
      onClick={() => { setConfirmation(group); setError(''); }}>
      <span className={`${iconClassName} bg-surface-2 text-muted-foreground`}><LogOut size={14} /></span>
      <span className="min-w-0 flex-1"><span className="block font-medium">{t('tab.leaveGroup')}</span>{!compact && <span className="block text-[11px] text-muted-foreground">{t('tab.leaveGroupShortHint')}</span>}</span>
    </button>}
  </div>)}</>;
}
