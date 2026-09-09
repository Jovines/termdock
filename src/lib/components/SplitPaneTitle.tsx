import { Terminal } from 'lucide-react';
import { useTerminalStore } from '../stores/useTerminalStore';
import { getSessionDisplayLines } from '../terminal/display';
import type { TerminalSessionInfo } from './MultiTerminalView';

/** Subscribe per pane so background title changes remain visible without focus. */
export function SplitPaneTitle({ session, active, onActivate }: {
  session: TerminalSessionInfo;
  active: boolean;
  onActivate: () => void;
}) {
  const title = useTerminalStore((store) => {
    const state = store.sessions.get(session.id);
    return getSessionDisplayLines(
      session, state?.activeProgram ?? null, state?.cwd ?? null, undefined,
      state?.shellTitle ?? null, state?.promptState ?? null,
    ).primary;
  });

  return (
    <button
      type="button"
      data-split-pane-title={session.id}
      aria-pressed={active}
      title={title}
      onClick={onActivate}
      className={`swiper-no-swiping flex h-6 min-h-6 w-full shrink-0 items-center gap-1.5 overflow-hidden border-b border-border/30 px-2 text-left text-[11px] leading-none app-chrome-bg hover:bg-surface focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary focus-visible:-outline-offset-1 ${active ? 'text-foreground' : 'text-muted-foreground'}`}
    >
      <Terminal size={11} className={`shrink-0 ${active ? 'text-primary' : ''}`} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {active && <span aria-hidden="true" className="h-1 w-1 shrink-0 rounded-full bg-primary" />}
    </button>
  );
}
