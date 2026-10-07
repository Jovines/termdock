import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal, Settings, type LucideIcon } from 'lucide-react';
import { useI18n } from '../../i18n';

interface UtilityAction {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  separated?: boolean;
}

export function SidebarUtilityActions({ onOpenSettings, serverAttention, actions }: {
  onOpenSettings: () => void;
  serverAttention: boolean;
  actions: UtilityAction[];
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const menu = menuRef.current;
    if (!root || !menu) return;
    const viewport = window.visualViewport;
    const positionMenu = () => {
      const anchor = root.getBoundingClientRect();
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
      const topEdge = (viewport?.offsetTop ?? 0) + 8;
      const viewportWidth = (viewport?.width ?? window.innerWidth) - 16;
      const bottomEdge = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 8;
      const width = Math.max(0, Math.min(256, viewportWidth));
      const above = Math.max(0, anchor.top - topEdge - 4);
      const below = Math.max(0, bottomEdge - anchor.bottom - 4);
      const openAbove = above >= 180 || above >= below;
      Object.assign(menu.style, {
        width: `${width}px`,
        left: `${Math.max(leftEdge, Math.min(anchor.right - width, leftEdge + viewportWidth - width))}px`,
        top: `${openAbove ? anchor.top - 4 : anchor.bottom + 4}px`,
        maxHeight: `${openAbove ? above : below}px`,
        transform: openAbove ? 'translateY(-100%)' : 'none',
      });
    };
    positionMenu();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(positionMenu);
    observer?.observe(root);
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    viewport?.addEventListener('resize', positionMenu);
    viewport?.addEventListener('scroll', positionMenu);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
      viewport?.removeEventListener('resize', positionMenu);
      viewport?.removeEventListener('scroll', positionMenu);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  return (
    <div
      ref={rootRef}
      role="group"
      data-sidebar-gesture-ignore
      aria-label={t('sidebar.moreActions')}
      className="relative z-20 mt-2 flex items-center justify-between gap-2"
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus({ preventScroll: true });
        }
      }}
    >
      <button
        type="button"
        onClick={onOpenSettings}
        title={serverAttention ? t('sidebar.serverAttention') : undefined}
        className="inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[11px] text-muted-foreground transition hover:bg-surface-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        <Settings size={14} className={serverAttention ? 'text-destructive' : undefined} />
        <span>{t('sidebar.settings')}</span>
      </button>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(current => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={`inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[11px] transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${open ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
      >
        <MoreHorizontal size={15} />
        <span>{t('sidebar.moreActions')}</span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          data-sidebar-gesture-ignore
          data-sidebar-composer-popover="sidebar-launch-options"
          aria-label={t('sidebar.moreActions')}
          className="fixed z-popover overflow-y-auto overscroll-contain rounded-xl border border-border/15 bg-surface p-1 shadow-[0_12px_32px_var(--app-shadow-soft)] animate-fade-in"
          onKeyDown={(event) => {
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            let next: number;
            if (event.key === 'ArrowDown') next = (current + 1) % items.length;
            else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = items.length - 1;
            else if (event.key === 'Tab') { setOpen(false); return; }
            else return;
            event.preventDefault();
            items[next]?.focus({ preventScroll: true });
          }}
        >
          {actions.map(({ label, icon: Icon, onSelect, separated }) => (
            <div key={label} role="none">
              {separated && <div role="separator" className="mx-2 my-1 h-px bg-border/40" />}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => { setOpen(false); onSelect(); }}
                className="flex min-h-10 w-full items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 text-left text-[12px] text-foreground transition hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
              >
                <Icon size={15} className="shrink-0 text-muted-foreground" />
                <span>{label}</span>
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
