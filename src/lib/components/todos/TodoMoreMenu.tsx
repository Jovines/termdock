import { useEffect, useId, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useKeyboardLayer } from '../../hooks/useKeyboardLayer';

export interface TodoMenuItem { label: string; action: () => void; disabled?: boolean; danger?: boolean }
export function TodoMoreMenu({ label = '更多操作', items, disabled }: { label?: string; items: TodoMenuItem[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const owner = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null), id = useId();
  useKeyboardLayer(menu, open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !owner.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  return <div ref={owner} className="relative z-20 shrink-0">
    <button type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      className="inline-flex min-h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40" onClick={() => setOpen(value => !value)}><MoreHorizontal size={20} /></button>
    {open && <div ref={menu} id={id} role="menu" aria-label={label} tabIndex={-1}
      className="absolute right-0 top-full z-30 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-xl border border-border/50 bg-surface p-1.5 shadow-xl"
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const choices = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
        const index = choices.indexOf(document.activeElement as HTMLButtonElement);
        choices[event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]?.focus();
      }}>
      {items.map(item => <button key={item.label} type="button" role="menuitem" disabled={item.disabled}
        className={`flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm outline-none transition hover:bg-surface-2 focus:bg-surface-2 disabled:opacity-40 ${item.danger ? 'text-destructive' : 'text-foreground'}`}
        onClick={() => { setOpen(false); item.action(); }}>{item.label}</button>)}
    </div>}
  </div>;
}
