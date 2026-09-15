import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, BellDot, X } from 'lucide-react';
import { subscribeClientState, type ControlSessionNoticeEvent } from '../utils/clientStateSync';
import { savedConnection } from '../federation/browserIntegration';
import { useSessionNoticeStore } from '../stores/useSessionNoticeStore';
import { readCachedSessionPersistenceSnapshot } from '../hooks/useSessionPersistence';
import { getCwdLeafName, getSessionDisplayName } from '../terminal/display';
import { useTerminalStore, getCachedShellTitle } from '../stores/useTerminalStore';
import { getWorkspaceHost, isWorkspaceActive, WORKSPACE_VISIBILITY_EVENT } from '../services/workspaceHost';
import { useI18n } from '../i18n';

const NOTICE_EVENT = 'termdock:session-notice';
interface Notice extends ControlSessionNoticeEvent { key: string; open: () => boolean }

/** Mounted after secure access, including in retained service workspaces. */
export function SessionNoticeBridge() {
  useEffect(() => {
    const updateViewing = () => useSessionNoticeStore.getState().view(
      !document.hidden && isWorkspaceActive() ? useTerminalStore.getState().activeSessionId : null,
    );
    updateViewing();
    const unsubscribe = useTerminalStore.subscribe((state, previous) => {
      if (state.activeSessionId !== previous.activeSessionId) updateViewing();
    });
    document.addEventListener('visibilitychange', updateViewing);
    window.addEventListener(WORKSPACE_VISIBILITY_EVENT, updateViewing);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', updateViewing);
      window.removeEventListener(WORKSPACE_VISIBILITY_EVENT, updateViewing);
      useSessionNoticeStore.getState().view(null);
    };
  }, []);
  useEffect(() => subscribeClientState(event => {
    if (event.type !== 'session-notice') return;
    useSessionNoticeStore.getState().receive(event.sessionId, event.id);
    const targetPeerId = savedConnection()?.targetPeerId;
    const host = getWorkspaceHost();
    const root = window.parent;
    const session = readCachedSessionPersistenceSnapshot().sessions.find(item => item.sessionId === event.sessionId);
    const terminal = useTerminalStore.getState().sessions.get(event.sessionId);
    const shellTitle = terminal?.shellTitle ?? getCachedShellTitle(event.sessionId);
    const contentTitle = shellTitle === terminal?.cwd || shellTitle === getCwdLeafName(terminal?.cwd ?? null) ? null : shellTitle;
    const sessionName = getSessionDisplayName(session ?? { name: event.sessionName },
      terminal?.activeProgram ?? null, null, undefined, contentTitle, terminal?.promptState ?? null);
    const detail: Notice = { ...event, sessionName, key: `${targetPeerId ?? 'local'}:${event.id}`, open: () => {
      if (targetPeerId && host) return host.focusSession(targetPeerId, event.sessionId);
      window.dispatchEvent(new CustomEvent('termdock:focus-session', { detail: event.sessionId }));
      return true;
    } };
    // Same-origin workspaces share a single visible notice surface in the host.
    // Nothing leaves the existing encrypted control connection.
    const notification = root.document.createEvent('CustomEvent');
    notification.initCustomEvent(NOTICE_EVENT, false, false, detail);
    root.dispatchEvent(notification);
  }), []);
  return null;
}

/** Outside the workspace's hidden/inert containers, so switching services keeps notices visible. */
export function SessionNoticeCenter() {
  const { locale } = useI18n();
  const chinese = locale === 'zh';
  const [notices, setNotices] = useState<Notice[]>([]);
  useEffect(() => {
    const receive = (event: Event) => {
      const notice = (event as CustomEvent<Notice>).detail;
      setNotices(previous => previous.some(item => item.key === notice.key) ? previous : [...previous, notice]);
    };
    window.addEventListener(NOTICE_EVENT, receive);
    return () => window.removeEventListener(NOTICE_EVENT, receive);
  }, []);
  const dismiss = useCallback((key: string) => {
    setNotices(previous => previous.filter(item => item.key !== key));
  }, []);
  const notice = notices[0];
  if (!notice) return null;
  return createPortal(<SessionNoticeCard key={notice.key} notice={notice} remaining={notices.length - 1}
    chinese={chinese} onDismiss={dismiss} />, document.body);
}

function SessionNoticeCard({ notice, remaining, chinese, onDismiss }: {
  notice: Notice; remaining: number; chinese: boolean; onDismiss: (key: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <section aria-label={chinese ? '关键进展提醒' : 'Progress reminder'}
      className="fixed left-3 right-3 top-[calc(var(--safe-top-inset,0px)+0.75rem)] z-toast overflow-hidden rounded-xl bg-surface text-foreground shadow-lg ring-1 ring-inset ring-border/15 animate-fade-in md:left-auto md:right-4 md:w-[360px]">
      <button type="button" aria-label={chinese ? '查看 Session' : 'Open session'}
        className="group flex w-full items-start gap-2.5 p-3.5 pr-11 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        onClick={() => { if (notice.open()) onDismiss(notice.key); else setFailed(true); }}>
        <BellDot size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0 flex-1" role="status" aria-live="polite" aria-atomic="true">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium" title={notice.sessionName}>{notice.sessionName}</span>
            <ArrowUpRight size={13} className="shrink-0 text-muted-foreground/60 transition-colors group-hover:text-primary" aria-hidden="true" />
          </span>
          {notice.title && <span className="mt-1 block truncate text-[11px] text-muted-foreground">{notice.title}</span>}
          <span className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/85" title={notice.message}>{notice.message}</span>
          {remaining > 0 && <span className="mt-2 block text-[10px] text-muted-foreground">{chinese ? `还有 ${remaining} 条` : `${remaining} more`}</span>}
          {failed && <span role="alert" className="mt-2 block text-xs text-warning">{chinese ? '暂时无法打开该服务，请重试。' : 'Unable to open the service. Please retry.'}</span>}
        </span>
      </button>
      <button type="button" aria-label={chinese ? '关闭提醒' : 'Dismiss reminder'}
        className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-tr-xl text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        onClick={() => onDismiss(notice.key)}><X size={14} /></button>
    </section>
  );
}
