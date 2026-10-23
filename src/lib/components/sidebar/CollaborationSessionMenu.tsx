import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { interruptActiveDrag } from '../../hooks/useDragInterruptionSensor';
import { useKeyboardLayer } from '../../hooks/useKeyboardLayer';
import { useSuperLongPress } from '../../hooks/useSuperLongPress';
import { useI18n } from '../../i18n';
import { SessionCollaborationActions } from './SessionCollaborationActions';

/** Saved members remain manageable even without an open or reachable terminal. */
export function CollaborationSessionMenu({ sessionId, groupId, label, detail, onOpen, children }: {
  sessionId: string; groupId: string; label: string; detail: string;
  onOpen: () => void; children: ReactNode;
}) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const row = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const bindLongPress = useSuperLongPress();
  const titleId = useId();
  const close = () => setAnchor(null);
  useKeyboardLayer(panel, !!anchor, close, () => trigger.current);
  const open = (point?: { x: number; y: number }) => {
    interruptActiveDrag();
    const rect = row.current?.getBoundingClientRect();
    setAnchor(point ?? { x: rect?.left ?? 8, y: rect?.bottom ?? 8 });
  };
  useLayoutEffect(() => {
    if (!anchor) return;
    const position = () => {
      if (!panel.current) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
      const desktop = window.matchMedia('(min-width: 1024px)').matches;
      const panelWidth = Math.min(desktop ? 320 : 384, width - 24);
      panel.current.style.width = `${panelWidth}px`;
      panel.current.style.maxHeight = `${height - (desktop ? 16 : 48)}px`;
      panel.current.style.left = `${desktop ? Math.max(left + 8, Math.min(anchor.x + 8, left + width - panelWidth - 8)) : left + (width - panelWidth) / 2}px`;
      panel.current.style.top = `${desktop ? Math.max(top + 8, Math.min(anchor.y + 8, top + height - panel.current.offsetHeight - 8)) : top + height - panel.current.offsetHeight - 24}px`;
    };
    position();
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    const observer = new ResizeObserver(position);
    if (panel.current) observer.observe(panel.current);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [anchor]);

  return <>
    <div ref={row} className="flex min-w-0 items-center rounded-sm hover:bg-surface-2" data-sidebar-gesture-ignore
      {...bindLongPress(() => open())}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); open({ x: event.clientX, y: event.clientY }); }}
      onKeyDown={event => {
        if (!(event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) return;
        event.preventDefault(); event.stopPropagation(); open();
      }}>
      {children}
      <button ref={trigger} type="button" aria-label={`成员操作：${label}`} title="成员操作" aria-haspopup="dialog" aria-expanded={!!anchor}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-surface-elevated hover:text-foreground md:h-7 md:w-7"
        onClick={event => { event.stopPropagation(); open(); }}><MoreHorizontal size={14} /></button>
    </div>
    {anchor && createPortal(<>
      <button type="button" className="fixed inset-0 z-menu-backdrop cursor-default bg-[var(--app-backdrop-soft)] md:bg-transparent" aria-label={t('tab.closeMenu')} onClick={close} />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className="fixed z-menu-panel flex flex-col overflow-hidden rounded-2xl border border-border/15 bg-surface-elevated text-foreground shadow-[0_18px_48px_var(--app-shadow-soft)]">
        <header className="shrink-0 border-b border-border/15 px-4 py-3"><h2 id={titleId} className="truncate text-sm font-medium" title={label}>{label}</h2><p className="mt-1 truncate text-[11px] text-muted-foreground" title={detail}>{detail}</p></header>
        <div className="min-h-0 overflow-y-auto overscroll-contain py-1">
          <SessionCollaborationActions sessionId={sessionId} groupId={groupId}
            itemClassName="flex min-h-11 items-center gap-3 px-4 py-3 text-left text-[13px] transition"
            iconClassName="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
            onOpen={() => { close(); onOpen(); }} onDone={close} />
        </div>
        <footer className="shrink-0 border-t border-border/15 px-3 py-2"><button type="button" className="min-h-11 w-full rounded-full bg-surface-2 px-3 text-xs text-muted-foreground hover:text-foreground" onClick={close}>{t('tab.closeMenu')}</button></footer>
      </div>
    </>, document.body)}
  </>;
}
