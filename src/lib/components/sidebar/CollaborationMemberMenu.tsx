import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Trash2 } from 'lucide-react';

/** Membership only: removing a member never destroys its terminal session. */
export function CollaborationMemberMenu({ label, disabled, onRemove, children }: {
  label: string; disabled: boolean; onRemove: () => void; children: ReactNode;
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const trigger = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = (restoreFocus = false) => {
    setPosition(null);
    if (restoreFocus) trigger.current?.querySelector('button')?.focus({ preventScroll: true });
  };
  useEffect(() => { if (disabled) setPosition(null); }, [disabled]);
  useLayoutEffect(() => {
    if (!position || !menu.current) return;
    const box = menu.current.getBoundingClientRect();
    menu.current.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - box.width - 8))}px`;
    menu.current.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - box.height - 8))}px`;
    menu.current.querySelector('button')?.focus({ preventScroll: true });
  }, [position]);
  useEffect(() => {
    if (!position) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'Tab') close();
    };
    const dismiss = () => close();
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [position]);
  return <span ref={trigger} className="inline-flex max-w-full items-center gap-0.5"
    onContextMenu={event => { if (disabled) return; event.preventDefault(); event.stopPropagation(); setPosition({ x: event.clientX, y: event.clientY }); }}
    onKeyDown={event => {
      if (!disabled && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
        event.preventDefault(); event.stopPropagation();
        const box = trigger.current!.getBoundingClientRect(); setPosition({ x: box.left, y: box.bottom });
      }
    }}>
    {children}
    {position && createPortal(<div ref={menu} role="menu" aria-label={`${label} 的成员操作`}
      style={{ left: position.x, top: position.y }}
      className="fixed z-popover min-w-44 rounded-lg border border-border/30 bg-surface-2 p-1 shadow-xl">
      <button type="button" role="menuitem" className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs text-destructive hover:bg-destructive/10 focus:bg-destructive/10 focus:outline-none"
        onClick={() => { close(true); onRemove(); }}><Trash2 size={14} />从协作组移除</button>
    </div>, document.body)}
  </span>;
}
