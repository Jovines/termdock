import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, PanelLeft, PanelRight, RefreshCw, Workflow } from 'lucide-react';
import { CollaborationTab, openCollaborationSession } from './AgentOperationsPanel';
import { collaborationPanelClientId } from '../../collaboration/panelPreferences';
import { useCollaborationNavigation } from '../../stores/useCollaborationNavigation';
import { isConnectionInterruption, SECURE_READY_EVENT, useConnectionRecovery } from '../../federation/connectionRecovery';
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
  const connection = useConnectionRecovery();
  const [showRecovery, setShowRecovery] = useState(false);
  useEffect(() => {
    if (connection === 'ready') { setShowRecovery(false); return; }
    const timer = setTimeout(() => setShowRecovery(true), 1000);
    return () => clearTimeout(timer);
  }, [connection]);
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
    void refresh();
    const visible = () => { if (!document.hidden && navigator.onLine !== false) void refresh(); };
    const timer = setInterval(visible, 10000);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener(SECURE_READY_EVENT, visible);
    window.addEventListener('pageshow', visible);
    return () => { cancelled = true; unsubscribe(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener(SECURE_READY_EVENT, visible); window.removeEventListener('pageshow', visible); };
  }, [refresh]);
  const group = directory?.groups.find(g => g.id === groupId);
  const openTerminal = async (session: NonNullable<CollaborationGroupsResponse>['sessions'][number]) => {
    await openCollaborationSession(session);
    useCollaborationNavigation.getState().terminal();
  };
  return <section aria-label="协作主工作区" className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-[var(--chrome-bg)] text-foreground">
    <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-border/15 px-2 sm:min-h-16 sm:gap-3 sm:px-6">
      {!leftSidebarVisible && <button type="button" aria-label="打开会话侧栏" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-2" onClick={onOpenSidebar}><PanelLeft size={17} /></button>}
      <Workflow size={18} className="hidden shrink-0 text-primary sm:block" />
      <div className="min-w-0 flex-1"><h2 ref={title} tabIndex={-1} className="truncate text-base font-semibold outline-none">{group?.name ?? '协作工作区'}</h2><p className="text-[11px] text-muted-foreground">{group ? `${group.sessionIds.length} 位成员` : '正在连接工作组'}</p></div>
      {onToggleRightSidebar && <button type="button" aria-label="文件侧栏" title="文件侧栏" aria-pressed={rightSidebarOpen} className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg ${rightSidebarOpen ? 'bg-surface-2 text-primary' : 'text-muted-foreground hover:bg-surface-2'}`} onClick={onToggleRightSidebar}><PanelRight size={17} /></button>}
      <button type="button" aria-label="返回终端" title="返回终端" className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-2 text-xs text-muted-foreground hover:bg-surface-2" onClick={() => useCollaborationNavigation.getState().terminal()}><Terminal size={17} /><span className="hidden sm:inline">返回终端</span></button>
    </header>
    <div className="flex min-h-0 flex-1 flex-col px-4 py-2 sm:px-6">
      {(showRecovery || isConnectionInterruption(loadError)) && <div role="status" className="mb-2 flex shrink-0 items-center gap-2 text-xs text-muted-foreground"><RefreshCw size={13} className={connection === 'offline' ? '' : 'animate-spin'} /><span>{connection === 'offline' ? '网络已断开，联网后自动恢复' : '正在恢复连接，当前结果和草稿已保留'}</span></div>}
      {(error || loadError && connection === 'ready' && !isConnectionInterruption(loadError)) && <div role="alert" className="mb-3 flex shrink-0 items-center gap-2 rounded-lg bg-destructive/10 p-3 text-xs text-destructive"><span className="flex-1">{error || loadError}</span><button type="button" aria-label="重新加载协作组" className="min-h-11 px-3" onClick={() => void refresh()}><RefreshCw size={14} /></button></div>}
      {notice && <p role="status" className="mb-3 shrink-0 text-xs text-primary">{notice}</p>}
      {!directory ? <p role="status" className="py-10 text-center text-sm text-muted-foreground">正在加载协作工作区…</p> : !group ? <p className="py-10 text-center text-sm text-muted-foreground">协作组已移除或暂不可用。任务记录仍保留在原服务中。</p> : <CollaborationTab fullWorkspace active notice={notice} groups={directory.groups} sessions={directory.sessions} agents={agents} sessionsState="loaded" selectedGroupId={selectedGroupId} setSelectedGroupId={setSelectedGroupId} initialGroupId={groupId} activeSessionId={activeSessionId} initialDrafts={drafts} onDraftChange={setDraft} docked={false} inputKeySuffix="main" floatingVisible floating={false} onOpenSession={openTerminal} onOpenTaskSession={openTerminal} defaultSessionMode={defaultSessionMode} busy={busy} setBusy={setBusy} setError={setError} setNotice={setNotice} refresh={refresh} />}
    </div>
  </section>;
}
