import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { useI18n } from '../../i18n';

/** Secondary commands float beside the trigger without moving the file list. */
export function ChangesToolbar({ children, actions }: {
  children: ReactNode;
  actions: (close: () => void) => ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current;
    const menu = panel.current;
    if (!anchor || !menu) return;
    const viewport = window.visualViewport;
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
      const topEdge = (viewport?.offsetTop ?? 0) + 8;
      const viewportWidth = Math.max(0, (viewport?.width ?? window.innerWidth) - 16);
      const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 16;
      const width = Math.min(240, viewportWidth);
      const above = Math.max(0, rect.top - topEdge - 6);
      const below = Math.max(0, bottomEdge - rect.bottom - 6);
      const openAbove = menu.scrollHeight > below && above > below;
      Object.assign(menu.style, {
        width: `${width}px`,
        left: `${Math.max(leftEdge, Math.min(rect.right - width, leftEdge + viewportWidth - width))}px`,
        top: `${openAbove ? rect.top - 6 : rect.bottom + 6}px`,
        maxHeight: `${openAbove ? above : below}px`,
        transform: openAbove ? 'translateY(-100%)' : 'none',
      });
    };
    position();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    observer?.observe(anchor);
    observer?.observe(menu);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    viewport?.addEventListener('resize', position);
    viewport?.addEventListener('scroll', position);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      viewport?.removeEventListener('resize', position);
      viewport?.removeEventListener('scroll', position);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);
  return (
    <div className="mt-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {children}
        <button
          ref={trigger}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setOpen(true);
            }
          }}
          className={`ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[11px] font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${open ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
        >
          <MoreHorizontal size={14} />
          {t('sidebar.moreActions')}
        </button>
      </div>
      {/* Keep scope dialogs mounted when their menu command closes the menu. */}
      {typeof document !== 'undefined' && createPortal(
        <div
          ref={panel}
          id={panelId}
          hidden={!open}
          role="menu"
          data-sidebar-gesture-ignore
          aria-label={t('sidebar.moreActions')}
          className="fixed z-menu-panel overflow-y-auto overscroll-contain rounded-lg border border-border/30 bg-surface p-1 shadow-[0_8px_24px_var(--app-shadow-soft)]"
          onKeyDown={(event) => {
            // Scope dialogs are portaled separately and own their keyboard events.
            if (!event.currentTarget.contains(event.target as Node)) return;
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            let next: number;
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            if (event.key === 'Tab') {
              close();
              return;
            }
            if (event.key === 'ArrowDown') next = (current + 1) % items.length;
            else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = items.length - 1;
            else return;
            event.preventDefault();
            items[next]?.focus({ preventScroll: true });
          }}
        >
          {actions(close)}
        </div>,
        document.body,
      )}
    </div>
  );
}
