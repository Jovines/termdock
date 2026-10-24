import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Maximize2, TerminalSquare, X } from 'lucide-react';
import { useSessionCapabilities } from '../../federation/ShareAccessContext';
import { focusKeyboardInput } from '../../hooks/nativeKeyboardLayout';

interface PeekContext {
  open: boolean; id: string;
  show: (anchor: HTMLElement) => void;
  leave: (related: EventTarget | null) => void;
  expand: () => void;
}
export const TerminalPeekContext = createContext<PeekContext | null>(null);

/** An interactive popover, rather than a tooltip or a second terminal client. */
export function TerminalPeekTrigger({ children, className }: { children: ReactNode; className: string }) {
  const peek = useContext(TerminalPeekContext);
  if (!peek) return <div className={className}>{children}</div>;
  return <button type="button" data-terminal-peek-trigger aria-label="查看会话终端" aria-haspopup="dialog" aria-expanded={peek.open} aria-controls={peek.open ? peek.id : undefined}
    className={`${className} text-left transition-colors hover:border-primary/40 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
    onPointerDown={event => event.preventDefault()}
    onPointerEnter={event => { if (event.pointerType === 'mouse' && window.matchMedia('(hover: hover) and (pointer: fine)').matches) peek.show(event.currentTarget); }}
    onPointerLeave={event => peek.leave(event.relatedTarget)}
    onClick={event => { if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) peek.show(event.currentTarget); else peek.expand(); }}>{children}</button>;
}

export function terminalPeekPosition(anchor: DOMRect, width: number, height: number) {
  const margin = 12, gap = 8;
  const above = anchor.top - margin, below = height - anchor.bottom - margin;
  const placement = above >= below ? 'above' : 'below';
  const panelHeight = Math.max(0, Math.min(560, (placement === 'above' ? above : below) - gap));
  const panelWidth = Math.max(0, Math.min(960, width - margin * 2));
  return {
    left: Math.max(margin, Math.min(anchor.left, width - panelWidth - margin)),
    top: placement === 'above' ? anchor.top - panelHeight - gap : anchor.bottom,
    width: panelWidth, height: panelHeight + gap,
    paddingTop: placement === 'below' ? gap : 0,
    paddingBottom: placement === 'above' ? gap : 0,
  };
}

export function useSessionTerminalPeek({ enabled, name, expand }: { enabled: boolean; name: string; expand: () => void }) {
  const capabilities = useSessionCapabilities();
  const available = enabled && capabilities.has('session.view');
  const id = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [engaged, setEngaged] = useState(false);
  const [position, setPosition] = useState<ReturnType<typeof terminalPeekPosition> | null>(null);
  // Portal into one stable host. Moving this host preserves the full terminal
  // component, its controller, connection, input node and toolbar state.
  const [host] = useState(() => { const node = document.createElement('div'); node.className = 'h-full min-h-0 w-full'; node.dataset.sessionTerminalHost = 'true'; return node; });
  const normalSlot = useRef<HTMLDivElement | null>(null), panel = useRef<HTMLDivElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const open = available && !!anchor;
  const openRef = useRef(open); openRef.current = open;
  const close = useCallback((restore = true) => {
    const focused = document.activeElement;
    const restoreTarget = restore && focused instanceof Node && host.contains(focused) ? previousFocus.current : null;
    setAnchor(null); setEngaged(false);
    if (restoreTarget?.isConnected) requestAnimationFrame(() => {
      if (restoreTarget.isConnected && (document.activeElement === document.body || host.contains(document.activeElement))) focusKeyboardInput(restoreTarget);
    });
  }, [host]);
  const show = useCallback((source: HTMLElement) => {
    if (!available) return;
    if (!openRef.current) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setEngaged(false);
    }
    setPosition(terminalPeekPosition(source.getBoundingClientRect(), window.innerWidth, window.innerHeight));
    setAnchor(source);
  }, [available]);
  const inside = useCallback((target: EventTarget | null) => target instanceof Node && (!!anchor?.contains(target) || !!panel.current?.contains(target)), [anchor]);
  const leave = useCallback((target: EventTarget | null) => { if (!inside(target)) close(); }, [inside, close]);
  const attachNormal = useCallback((node: HTMLDivElement | null) => { normalSlot.current = node; if (node && !openRef.current) node.append(host); }, [host]);
  const attachPeek = useCallback((node: HTMLDivElement | null) => {
    if (node) node.append(host); else normalSlot.current?.append(host);
  }, [host]);
  const expandTerminal = () => { close(false); expand(); };
  useEffect(() => { if (!available) close(false); }, [available, close]);
  useLayoutEffect(() => () => host.remove(), [host]);
  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const positionAtAnchor = () => {
      if (!anchor.isConnected) return;
      const rect = anchor.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) { close(); return; }
      const next = terminalPeekPosition(rect, window.innerWidth, window.innerHeight);
      setPosition(current => current && Object.keys(next).every(key => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
    };
    const observer = new ResizeObserver(positionAtAnchor);
    observer.observe(anchor); if (anchor.parentElement) observer.observe(anchor.parentElement);
    window.addEventListener('resize', positionAtAnchor);
    document.addEventListener('scroll', positionAtAnchor, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', positionAtAnchor); document.removeEventListener('scroll', positionAtAnchor, true); };
  }, [open, anchor, close]);
  useEffect(() => {
    if (!open) return;
    const move = (event: PointerEvent) => { if (event.pointerType === 'mouse' && !inside(event.target)) close(); };
    const outside = (event: PointerEvent) => { if (!inside(event.target)) close(); };
    const windowLeave = (event: PointerEvent) => { if (!event.relatedTarget) close(); };
    const blur = () => close();
    document.addEventListener('pointermove', move, true); document.addEventListener('pointerdown', outside, true); document.addEventListener('pointerout', windowLeave);
    window.addEventListener('blur', blur);
    return () => { document.removeEventListener('pointermove', move, true); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('pointerout', windowLeave); window.removeEventListener('blur', blur); };
  }, [open, inside, close]);
  // Hover only reveals the canvas. Explicit terminal interaction enables its
  // existing input gate synchronously, before that very pointer/wheel event.
  const engage = () => { if (!engaged && capabilities.has('session.input')) flushSync(() => setEngaged(true)); };
  useLayoutEffect(() => {
    if (!open) return;
    // The terminal's stable portal keeps its React ancestry in the workspace;
    // use its DOM host for capture when it has moved into the popover.
    const interact = () => { if (openRef.current) engage(); };
    host.addEventListener('pointerdown', interact, true); host.addEventListener('wheel', interact, true); host.addEventListener('focusin', interact, true);
    return () => { host.removeEventListener('pointerdown', interact, true); host.removeEventListener('wheel', interact, true); host.removeEventListener('focusin', interact, true); };
  });
  return {
    host, attachNormal,
    open,
    interactive: open && engaged && capabilities.has('session.input'),
    context: available ? { open, id, show, leave, expand: expandTerminal } : null,
    popover: open && position ? createPortal(<div ref={panel} style={position} data-terminal-peek id={id} role="dialog" aria-label="会话终端预览" aria-modal="false"
      className="fixed z-menu-panel box-border" onPointerLeave={event => leave(event.relatedTarget)}>
      <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-[var(--chrome-bg)] text-foreground shadow-2xl">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs text-muted-foreground"><TerminalSquare size={15} /><span className="min-w-0 flex-1 truncate">{name}</span>
          <button type="button" aria-label="在完整会话中打开终端" title="在完整会话中打开终端" className="inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-surface-2" onClick={expandTerminal}><Maximize2 size={14} /></button>
          <button type="button" aria-label="关闭终端预览" className="inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-surface-2" onClick={() => close()}><X size={15} /></button>
        </header>
        <div ref={attachPeek} className="min-h-0 flex-1" />
      </section>
    </div>, document.body) : null,
  };
}
