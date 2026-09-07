import { useEffect, useRef, useState } from 'react';
import { Ellipsis, Moon, RefreshCw, Sun } from 'lucide-react';
import { useI18n } from '../../i18n';

export default function ModelViewerMenu({ dark, onToggleBackground, onRefresh, onView }: { dark: boolean; onToggleBackground: () => void; onRefresh?: () => void; onView?: (view: 'fit' | 'front' | 'top' | 'right') => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    firstAction.current?.focus();
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <div ref={root} data-model-viewer-menu={open ? 'open' : 'closed'} className="relative z-20 shrink-0" onKeyDown={(event) => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <button ref={trigger} type="button" aria-label={t('rightSidebar.model3dMore')} aria-expanded={open} onClick={() => setOpen((value) => !value)}
      className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-muted-foreground hover:bg-surface-elevated"><Ellipsis size={17} /></button>
    {open && <div className="absolute right-0 top-full z-30 mt-2 w-48 rounded-xl border border-border/30 bg-surface p-1 shadow-lg">
      <button ref={firstAction} type="button" onClick={() => { onToggleBackground(); close(); }} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-foreground hover:bg-surface-2">
        {dark ? <Sun size={16} /> : <Moon size={16} />}{t(dark ? 'rightSidebar.model3dBgToLight' : 'rightSidebar.model3dBgToDark')}
      </button>
      {onView && (['fit', 'front', 'top', 'right'] as const).map((view) => <button key={view} type="button"
        onClick={() => { close(); onView(view); }} className="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm text-foreground hover:bg-surface-2">
        {t(view === 'fit' ? 'rightSidebar.model3dFit' : view === 'front' ? 'rightSidebar.model3dFront' : view === 'top' ? 'rightSidebar.model3dTop' : 'rightSidebar.model3dRight')}
      </button>)}
      {onRefresh && <button type="button" onClick={() => { close(); onRefresh(); }} className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-foreground hover:bg-surface-2"><RefreshCw size={16} />{t('rightSidebar.model3dRefresh')}</button>}
    </div>}
  </div>;
}
