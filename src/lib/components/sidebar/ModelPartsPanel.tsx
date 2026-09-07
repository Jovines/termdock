import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Focus, Search, Undo2, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { ModelPartInfo } from './modelVisibility';

interface Props {
  parts: ModelPartInfo[];
  hidden: string[];
  selected: string | null;
  wide: boolean;
  canUndo: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onIsolate: (id: string) => void;
  onShowAll: () => void;
  onUndo: () => void;
  onClose: () => void;
}

/** A non-modal inspector: keep the model visible and usable while editing visibility. */
export default function ModelPartsPanel({ parts, hidden, selected, wide, canUndo, onSelect, onToggle, onIsolate, onShowAll, onUndo, onClose }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [hiddenOnly, setHiddenOnly] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-part-id="${selected}"]`);
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }, [selected]);
  const filtered = parts.filter((part) => part.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    && (!hiddenOnly || hidden.includes(part.id)));
  return (
    <section aria-label={t('rightSidebar.model3dParts')} className={`swiper-no-swiping relative z-20 flex min-h-0 shrink-0 flex-col bg-surface ${wide ? 'h-full w-72 border-l border-border/30' : 'h-[42%] border-t border-border/30'}`}
      onPointerDown={(event) => event.stopPropagation()} onTouchStart={(event) => event.stopPropagation()}>
      <div className="flex shrink-0 items-center gap-2 px-3 pt-1">
        <h3 className="min-w-0 flex-1 text-sm font-medium text-foreground">{t('rightSidebar.model3dParts')} <span className="text-xs text-muted-foreground">{parts.length - hidden.length}/{parts.length}</span></h3>
        <button type="button" onClick={onClose} aria-label={t('rightSidebar.model3dCloseParts')} className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-2"><X size={18} /></button>
      </div>
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
        <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-surface-2 px-2 text-muted-foreground">
          <Search size={14} className="shrink-0" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('rightSidebar.model3dSearchParts')} aria-label={t('rightSidebar.model3dSearchParts')}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none" />
          {query && <button type="button" aria-label={t('rightSidebar.model3dClearPartSearch')} onClick={() => setQuery('')} className="inline-flex h-9 w-7 shrink-0 items-center justify-center"><X size={14} /></button>}
        </div>
        <button type="button" aria-pressed={hiddenOnly} onClick={() => setHiddenOnly((value) => !value)}
          className={`h-9 shrink-0 rounded-lg px-2 text-xs ${hiddenOnly ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-muted-foreground'}`}>
          {t('rightSidebar.model3dHiddenParts', { count: hidden.length })}
        </button>
      </div>
      <div ref={listRef} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-2" role="list" aria-label={t('rightSidebar.model3dParts')}>
        {filtered.map((part) => {
          const isHidden = hidden.includes(part.id);
          return <div key={part.id} data-part-id={part.id} role="listitem" className={`flex min-h-11 items-center rounded-lg ${selected === part.id ? 'bg-accent/10' : 'hover:bg-surface-2'}`}>
            <button type="button" onClick={() => onSelect(part.id)} aria-pressed={selected === part.id} title={part.name}
              className={`min-h-11 min-w-0 flex-1 px-2 py-2 text-left text-sm leading-snug ${isHidden ? 'text-muted-foreground' : 'text-foreground'}`}>
              <span className="line-clamp-2 break-words">{part.name}</span>
            </button>
            <button type="button" onClick={() => onToggle(part.id)} aria-label={t(isHidden ? 'rightSidebar.model3dShowNamedPart' : 'rightSidebar.model3dHideNamedPart', { name: part.name })}
              title={t(isHidden ? 'rightSidebar.model3dShowNamedPart' : 'rightSidebar.model3dHideNamedPart', { name: part.name })}
              className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-surface-elevated ${isHidden ? 'text-muted-foreground' : 'text-foreground'}`}>
              {isHidden ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
            <button type="button" onClick={() => onIsolate(part.id)} aria-label={t('rightSidebar.model3dIsolateNamedPart', { name: part.name })} title={t('rightSidebar.model3dIsolateNamedPart', { name: part.name })}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-elevated hover:text-foreground"><Focus size={17} /></button>
          </div>;
        })}
        {filtered.length === 0 && <p className="px-2 py-5 text-center text-sm text-muted-foreground">{t('rightSidebar.model3dNoParts')}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border/20 px-3 py-1 pb-[max(0.25rem,env(safe-area-inset-bottom,0px))]">
        <button type="button" onClick={onUndo} disabled={!canUndo} className="inline-flex h-10 items-center gap-1 rounded-lg px-2 text-sm text-foreground disabled:opacity-40"><Undo2 size={15} />{t('rightSidebar.model3dUndoVisibility')}</button>
        <button type="button" onClick={onShowAll} disabled={hidden.length === 0} className="ml-auto h-10 rounded-lg px-2 text-sm text-foreground disabled:opacity-40">{t('rightSidebar.model3dShowAllParts', { count: hidden.length })}</button>
      </div>
    </section>
  );
}
