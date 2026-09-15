import { GripVertical, PanelRight, Terminal } from 'lucide-react';
import { useI18n } from '../i18n';
import { useTerminalStore } from '../stores/useTerminalStore';
import { getSessionDisplayLines } from '../terminal/display';
import type { TerminalSessionInfo } from './MultiTerminalView';

/** Subscribe per pane so background title changes remain visible without focus. */
export function SplitPaneTitle({ session, active, onActivate, onToggleRightSidebar }: {
  session: TerminalSessionInfo;
  active: boolean;
  onActivate: () => void;
  onToggleRightSidebar?: () => void;
}) {
  const { t } = useI18n();
  const title = useTerminalStore((store) => {
    const state = store.sessions.get(session.id);
    return getSessionDisplayLines(
      session, state?.activeProgram ?? null, state?.cwd ?? null, undefined,
      state?.shellTitle ?? null, state?.promptState ?? null,
    ).primary;
  });

  return (
    <div className="swiper-no-swiping flex h-6 min-h-6 shrink-0 items-center border-b border-border app-chrome-bg">
    <button
      type="button"
      data-split-pane-title={session.id}
      draggable={false}
      onDragStart={event => event.preventDefault()}
      aria-pressed={active}
      title={`${title} · 拖动标题移动，边缘拆分，中央交换`}
      onClick={onActivate}
      className="split-pane-drag-handle flex h-full min-w-0 cursor-grab active:cursor-grabbing flex-1 items-center gap-1.5 overflow-hidden px-2 text-left text-[12px] font-medium leading-none text-foreground hover:bg-surface focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary focus-visible:-outline-offset-1"
    >
      <Terminal size={11} className={`shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <GripVertical size={12} aria-hidden="true" className="shrink-0 text-muted-foreground" />
      {active && <span aria-hidden="true" className="h-1 w-1 shrink-0 rounded-full bg-primary" />}
    </button>
    {onToggleRightSidebar && (
      <button
        type="button"
        onClick={onToggleRightSidebar}
        aria-label={t('tab.explorerTitle')}
        title={t('tab.explorerTitle')}
        className="inline-flex h-full w-7 shrink-0 items-center justify-center text-muted-foreground hover:bg-surface hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary focus-visible:-outline-offset-1"
      >
        <PanelRight size={14} />
      </button>
    )}
    </div>
  );
}
