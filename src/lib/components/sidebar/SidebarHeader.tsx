import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Pin, PinOff, X, type LucideIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { SidebarUtilityActions } from './SidebarUtilityActions';

type HeaderAction = { label: string; icon: LucideIcon; onSelect: () => void };
const buttonClass = 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-primary/15 hover:text-primary active:scale-95';

export function SidebarHeader({ label, count, badge, actions, pinned, onTogglePinned, onClose, onOpenSettings, serverAttention }: {
  label: string; count: number; badge?: ReactNode; actions: HeaderAction[]; pinned: boolean;
  onTogglePinned?: () => void; onClose: () => void; onOpenSettings: () => void; serverAttention: boolean;
}) {
  const { t } = useI18n();
  const header = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLDivElement>(null);
  // Start compact so the first frame is safe before the measured desktop inset.
  const [compact, setCompact] = useState(true);
  useLayoutEffect(() => {
    const element = header.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const available = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const button = element.querySelector('button');
      const size = button ? button.getBoundingClientRect().width : 36;
      const pieces = [...(title.current?.children ?? [])] as HTMLElement[];
      const titleWidth = pieces.reduce((sum, part) => sum + part.scrollWidth, 0) + Math.max(0, pieces.length - 1) * 6;
      const buttons = actions.length + (onTogglePinned ? 1 : 0) + (pinned ? 0 : 1);
      const required = titleWidth + buttons * size + Math.max(0, buttons - 1) * 4 + 6;
      setCompact(available < required + 8);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  });

  return <div ref={header} data-session-sidebar-header className="relative z-20 shrink-0 px-3 py-0.5">
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-3 bottom-0 z-10 h-px bg-border opacity-40" />
    <div className="flex min-w-0 w-full items-center gap-1.5">
      <div className="min-w-0 flex-1 overflow-hidden">
        <div ref={title} className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          <span className="min-w-0 truncate text-[12px] font-medium text-muted-foreground">{label}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{count}</span>
          {badge && <span className="flex shrink-0 items-center">{badge}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {compact ? <SidebarUtilityActions compact actions={actions} serverAttention={serverAttention} onOpenSettings={onOpenSettings} /> : actions.map(({ label: name, icon: Icon, onSelect }) => <button
          key={name} data-session-sidebar-header-action type="button" className={buttonClass}
          aria-label={name} title={name} onClick={onSelect}
        ><Icon size={16} /></button>)}
        {onTogglePinned && <button data-session-sidebar-header-action type="button" className={buttonClass}
          onClick={onTogglePinned} aria-label={pinned ? t('sidebar.unpinSidebar') : t('sidebar.pinSidebar')}
          title={pinned ? t('sidebar.unpinSidebar') : t('sidebar.pinSidebar')} aria-pressed={pinned}
        >{pinned ? <PinOff size={16} /> : <Pin size={16} />}</button>}
        {!pinned && <button data-session-sidebar-header-action type="button" className={buttonClass} onClick={onClose} aria-label={t('common.close')}><X size={16} /></button>}
      </div>
    </div>
  </div>;
}
