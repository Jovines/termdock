import { GripVertical, PanelRight, Terminal } from 'lucide-react';
import { useI18n } from '../i18n';
import { useTerminalStore } from '../stores/useTerminalStore';
import { sessionOption, useSessionDirectory, useSessionDirectoryStore } from '../stores/useSessionDirectory';
import type { TerminalSessionInfo } from './MultiTerminalView';
import { SessionModeSwitch } from './chat/SessionModeSwitch';

/** Subscribe per pane so background title changes remain visible without focus. */
export function SplitPaneTitle({ session, active, onActivate, onToggleRightSidebar }: {
  session: TerminalSessionInfo;
  active: boolean;
  onActivate: () => void;
  onToggleRightSidebar?: () => void;
}) {
  const { t } = useI18n();
  const directory = useSessionDirectory();
  const shellNames = useSessionDirectoryStore(state => state.shellNames);
  const fallbackTitle = useTerminalStore(store => sessionOption({ ...session,
    sessionId: session.id, lastActivity: 0 }, store.sessions.get(session.id), shellNames).displayName);
  const title = directory.find(record => record.sessionId === session.id)?.displayName ?? fallbackTitle;

  return (
    <div data-pane-titlebar="true" className="swiper-no-swiping flex h-6 min-h-6 shrink-0 items-center border-b border-border app-chrome-bg text-foreground">
    <button
      type="button"
      data-split-pane-title={session.id}
      draggable={false}
      onDragStart={event => event.preventDefault()}
      aria-pressed={active}
      title={`${title} · 拖动标题移动，边缘拆分，中央交换`}
      onClick={onActivate}
      className="split-pane-drag-handle flex h-full min-w-0 cursor-grab active:cursor-grabbing flex-1 items-center gap-1.5 overflow-hidden px-2 text-left text-[12px] font-medium leading-none hover:opacity-80 focus-visible:outline focus-visible:outline-1 focus-visible:outline-current focus-visible:-outline-offset-1"
    >
      <Terminal size={11} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <GripVertical size={12} aria-hidden="true" className="shrink-0 opacity-60" />
    </button>
    <SessionModeSwitch sessionId={session.id} compact onActivate={active ? undefined : onActivate} />
    {onToggleRightSidebar && (
      <button
        type="button"
        onClick={onToggleRightSidebar}
        aria-label={t('tab.explorerTitle')}
        title={t('tab.explorerTitle')}
        className="inline-flex h-full w-7 shrink-0 items-center justify-center hover:opacity-80 focus-visible:outline focus-visible:outline-1 focus-visible:outline-current focus-visible:-outline-offset-1"
      >
        <PanelRight size={14} />
      </button>
    )}
    </div>
  );
}
