import { useCallback, useEffect, useRef, useState } from 'react';
import { PanelLeft, PanelRight, Workflow } from 'lucide-react';
import { useAppFeedback } from '../ui/AppFeedback';
import { CollaborationTab, openCollaborationSession } from './AgentOperationsPanel';
import { collaborationPanelClientId, openCollaborationMessagesPanel } from '../../collaboration/panelPreferences';
import { useCollaborationNavigation } from '../../stores/useCollaborationNavigation';
import { SECURE_READY_EVENT } from '../../federation/connectionRecovery';
import { startVisiblePolling } from './startVisiblePolling';
import { getAgentLaunchers, getSettings, listCollaborationGroups, subscribeCollaborationGroups,
  type AgentLauncherInfo, type CollaborationGroupsResponse } from '../../terminal/api';

/** A primary workspace, rendered alongside the still-mounted terminal tree. */
export default function CollaborationMainWorkspace({ groupId, activeSessionId, onOpenSidebar, leftSidebarVisible = false, onToggleRightSidebar, rightSidebarOpen = false, defaultSessionMode }: {
  leftSidebarVisible?: boolean; onToggleRightSidebar?: () => void; rightSidebarOpen?: boolean; groupId: string; activeSessionId: string | null; onOpenSidebar: () => void; defaultSessionMode: 'shell' | 'tmux';
}) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => { title.current?.focus(); }, []);
  const [directory, setDirectory] = useState<CollaborationGroupsResponse | null>(null);
  const [agents, setAgents] = useState<AgentLauncherInfo[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useAppFeedback(loadError ? { tone: 'recovering', message: '正在恢复协作同步…' } : null);
  useAppFeedback(error ? { message: error } : null);
  const initialView = useCollaborationNavigation(state => state.view);
  const drafts = useCollaborationNavigation(state => state.drafts);
  const setDraft = useCollaborationNavigation(state => state.setDraft);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(groupId);
  const refresh = useCallback(async () => {
    try { const next = await listCollaborationGroups(); setDirectory(next); setLoadError(null); }
    catch (e) { setLoadError(e instanceof Error ? e.message : '协作组加载失败'); }
  }, []);
  useEffect(() => {
    let cancelled = false;
    void getAgentLaunchers().then(next => { if (!cancelled) setAgents(next); }).catch(() => {});
    void getSettings().then(settings => {
      if (cancelled) return;
      const saved = settings.collaborationPanels?.[collaborationPanelClientId()]?.drafts;
      for (const [id, draft] of Object.entries(saved ?? {})) {
        if (!useCollaborationNavigation.getState().drafts[id]) setDraft(id, draft);
      }
    }).catch(() => {});
    const unsubscribe = subscribeCollaborationGroups(next => { if (!cancelled) { setDirectory(next); setLoadError(null); } });
    const stopPolling = startVisiblePolling(() => { if (navigator.onLine !== false) void refresh(); }, 10000, [SECURE_READY_EVENT, 'pageshow']);
    return () => { cancelled = true; unsubscribe(); stopPolling(); };
  }, [refresh]);
  const group = directory?.groups.find(g => g.id === groupId);
  const openTerminal = async (session: NonNullable<CollaborationGroupsResponse>['sessions'][number]) => {
    await openCollaborationSession(session);
    useCollaborationNavigation.getState().terminal();
  };
  return <section aria-label="协作主工作区" className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-[var(--chrome-bg)] text-foreground">
    <header data-termdock-window-header="true" className="flex min-h-14 shrink-0 items-center gap-1 border-b border-border/15 px-2 sm:min-h-16 sm:gap-3 sm:px-6">
      {!leftSidebarVisible && <button type="button" aria-label="打开会话侧栏" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-2" onClick={onOpenSidebar}><PanelLeft size={17} /></button>}
      <Workflow size={18} className="hidden shrink-0 text-primary sm:block" />
      <div className="min-w-0 flex-1"><h2 ref={title} tabIndex={-1} className="truncate text-base font-semibold outline-none">{group?.name ?? '协作工作区'}</h2><p className="text-[11px] text-muted-foreground">{group ? `${group.sessionIds.length} 位成员` : '正在连接工作组'}</p></div>
      {onToggleRightSidebar && <button type="button" aria-label="文件侧栏" title="文件侧栏" aria-pressed={rightSidebarOpen} className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg ${rightSidebarOpen ? 'bg-surface-2 text-primary' : 'text-muted-foreground hover:bg-surface-2'}`} onClick={onToggleRightSidebar}><PanelRight size={17} /></button>}
    </header>
    <div className="flex min-h-0 flex-1 flex-col px-4 py-2 sm:px-6">
      {notice && <p role="status" className="mb-3 shrink-0 text-xs text-primary">{notice}</p>}
      {!directory ? <p role="status" className="py-10 text-center text-sm text-muted-foreground">正在加载协作工作区…</p> : !group ? <p className="py-10 text-center text-sm text-muted-foreground">协作组已移除或暂不可用。任务记录仍保留在原服务中。</p> : <CollaborationTab fullWorkspace initialView={initialView} active notice={notice} groups={directory.groups} sessions={directory.sessions} agents={agents} sessionsState="loaded" selectedGroupId={selectedGroupId} setSelectedGroupId={setSelectedGroupId} initialGroupId={groupId} activeSessionId={activeSessionId} initialDrafts={drafts} onDraftChange={setDraft} docked={false} inputKeySuffix="main" floatingVisible floating={false} onOpenSession={openTerminal} onOpenTaskSession={openTerminal} onDockMessages={activeSessionId ? async () => { await openCollaborationMessagesPanel(groupId, activeSessionId); } : undefined} defaultSessionMode={defaultSessionMode} busy={busy} setBusy={setBusy} setError={setError} setNotice={setNotice} refresh={refresh} />}
    </div>
  </section>;
}
