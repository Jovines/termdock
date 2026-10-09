import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { ArrowLeft, ChevronDown, X } from 'lucide-react';
import { useKeyboardLayer } from '../../hooks/useKeyboardLayer';
import { useI18n } from '../../i18n';

/** A reading pane with its own scroll surface, docked beside the fullscreen map. */
export function ArchitectureInspector({ title, stageKey, source = false, fullHeight = false, inGraph = false, docked = false, side = false, active = true, onBack, backLabel, onClose, onDismiss, onCollapse, children }: {
  title: string;
  stageKey: string;
  source?: boolean;
  fullHeight?: boolean;
  inGraph?: boolean;
  docked?: boolean;
  side?: boolean;
  active?: boolean;
  onBack?: () => void;
  backLabel?: string;
  onClose: () => void;
  onDismiss: () => void;
  onCollapse?: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  useKeyboardLayer(root, active && !inGraph, onDismiss);
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = positions.current.get(stageKey) ?? 0;
    if (active) root.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [stageKey, active]);
  const placement = docked
    ? 'relative h-[48%] max-h-96 w-full shrink-0 min-[768px]:h-full min-[768px]:max-h-none min-[768px]:w-[22rem]'
    : inGraph
    ? `${source || fullHeight ? 'inset-0' : 'inset-x-0 bottom-0 max-h-[48%]'} min-[768px]:inset-y-0 min-[768px]:left-auto min-[768px]:right-0 min-[768px]:max-h-none ${source || fullHeight ? 'min-[768px]:w-[min(50vw,40rem)]' : 'min-[768px]:w-[22rem]'}`
    : side ? 'inset-y-0 right-0 w-[22rem] max-w-full' : 'inset-0';
  const button = 'inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs text-primary hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-ring';
  const rememberPosition = () => { if (body.current) positions.current.set(stageKey, body.current.scrollTop); };
  return <aside ref={root} tabIndex={-1} role={inGraph ? undefined : 'dialog'} aria-modal={inGraph ? undefined : false} aria-label={title} data-architecture-inspector data-sidebar-gesture-ignore onClickCapture={rememberPosition} className={`${docked ? '' : 'absolute'} z-20 flex min-h-0 flex-col overflow-hidden border border-border/30 bg-surface shadow-xl ${placement}`}>
    <header className="flex shrink-0 items-center gap-2 border-b border-border/15 px-2 py-1">
      <button type="button" className={button} aria-label={onBack ? backLabel : t('architecture.closeDetail')} onClick={onBack ?? onClose}><ArrowLeft size={17} /><span>{onBack ? backLabel : t('architecture.backToMap')}</span></button>
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={title}>{title}</h2>
      {onCollapse && <button type="button" className={button} aria-label={t('architecture.collapseDetail')} onClick={onCollapse}><ChevronDown size={17} /></button>}
      {onBack && <button type="button" className={button} aria-label={t('architecture.closeDetail')} onClick={onClose}><X size={17} /></button>}
    </header>
    <div ref={body} onScroll={rememberPosition} className={`min-h-0 flex-1 ${source ? 'overflow-hidden' : 'overflow-y-auto overscroll-contain p-3'}`}>{children}</div>
  </aside>;
}
