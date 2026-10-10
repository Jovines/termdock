import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Check, Home, Link2, RefreshCw, X } from 'lucide-react';
import { FileTree } from './FileTree';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { relativeScopePath } from '../../architecture/scopePaths';
import { useKeyboardLayer } from '../../hooks/useKeyboardLayer';
import { useI18n } from '../../i18n';

/** Read-only directory browsing shared by the adjacent browser and modal picker. */
export function ArchitecturePathBrowser({ rootPath, initialDirectory, selected, onChange, selectionDisabled = false, compact = false }: {
  rootPath: string;
  initialDirectory?: string | null;
  selected: string[];
  onChange: (paths: string[]) => void;
  selectionDisabled?: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const root = rootPath.replace(/\/+$/, '') || '/';
  const [directory, setDirectory] = useState(() => initialDirectory && relativeScopePath(initialDirectory, root) ? initialDirectory.replace(/\/+$/, '') : root);
  const [query, setQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [copiedReference, setCopiedReference] = useState<string | null>(null);
  useEffect(() => {
    if (!copiedReference) return;
    const timeout = window.setTimeout(() => setCopiedReference(null), 1800);
    return () => window.clearTimeout(timeout);
  }, [copiedReference]);
  const invalidate = useSidebarStore(state => state.invalidateDirectoryCache);
  const referencePaths = new Set(selected.map(path => `${root === '/' ? '' : root}/${path}`));
  const addReference = (value: string) => {
    const path = relativeScopePath(value, root);
    if (selectionDisabled || !path || selected.includes(path) || selected.length >= 20) return;
    onChange([...selected, path]);
  };
  const openDirectory = (path: string) => {
    if (path !== root && !relativeScopePath(path, root)) return;
    setDirectory(path); setQuery(''); setSelectedFile(null);
  };
  const button = `inline-flex shrink-0 items-center justify-center rounded-lg text-xs hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 ${compact ? 'h-8 w-8 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11' : 'h-11 w-11'}`;
  const currentRelative = relativeScopePath(directory, root);
  return <>
      <div className="shrink-0 px-2 py-1">
        <div className="flex items-center gap-1"><button type="button" className={button} disabled={directory === root} aria-label={t('rightSidebar.parentFolder')} onClick={() => openDirectory(directory.slice(0, directory.lastIndexOf('/')) || root)}><ArrowUp size={17} /></button><button type="button" className={button} disabled={directory === root} aria-label={t('rightSidebar.backToProjectRoot')} onClick={() => openDirectory(root)}><Home size={16} /></button><span className="min-w-0 flex-1 truncate text-xs font-medium" title={directory}>{currentRelative ?? (directory.split('/').pop() || '/')}</span>{currentRelative && <button type="button" className={`${button} text-primary`} disabled={selectionDisabled || (!selected.includes(currentRelative) && selected.length >= 20)} aria-label={`${t('architecture.addScopeReference')}: ${directory.split('/').pop()}`} title={currentRelative} aria-pressed={selected.includes(currentRelative)} onClick={() => addReference(directory)}>{selected.includes(currentRelative) ? <Check size={15} /> : <Link2 size={15} />}</button>}<button type="button" className={button} aria-label={t('rightSidebar.refreshFiles')} onClick={() => { invalidate(directory, true); setRefresh(value => value + 1); }}><RefreshCw size={15} /></button></div>
      </div>
      {selectionDisabled && <p role="alert" className="shrink-0 px-3 pb-2 text-xs text-muted-foreground">{t('architecture.correctPathsFirst')}</p>}
      <div className="shrink-0 border-b border-border/15 px-3 pb-2"><input aria-label={t('architecture.searchScopePaths')} placeholder={t('architecture.searchScopePaths')} value={query} onChange={event => setQuery(event.target.value)} className={`${compact ? 'h-9 [@media(pointer:coarse)]:h-11' : 'h-11'} w-full rounded-lg border border-border/20 bg-surface-2 px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring`} /></div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain bg-surface">
        <FileTree key={`${directory}:${refresh}`} rootPath={directory} selectedFilePath={selectedFile} onFileSelect={path => { setSelectedFile(path); addReference(path); }} onDirectoryRoot={openDirectory} onPathReference={addReference} getReferenceText={path => relativeScopePath(path, root) ?? path} query={query} onReferenceCopied={setCopiedReference} copiedReferenceKey={copiedReference} onSearchFromDirectory={openDirectory} referenceSelection={{ paths: referencePaths, label: t('architecture.addScopeReference'), disabled: selectionDisabled || selected.length >= 20 }} />
      </div>
  </>;
}

/** Mobile/narrow selection is a draft until confirmation; desktop selection is live. */
export function ArchitecturePathPicker({ rootPath, initialDirectory, initial, onConfirm, onCancel }: {
  rootPath: string;
  initialDirectory?: string | null;
  initial: string[];
  onConfirm: (paths: string[]) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLElement>(null);
  useKeyboardLayer(dialog, true, onCancel);
  const titleId = useId();
  const [selected, setSelected] = useState(initial);
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; };
  }, []);
  const button = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-xs hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40';
  return createPortal(<div className="fixed inset-0 z-popover flex items-center justify-center p-[max(0.75rem,env(safe-area-inset-top))]">
    <button type="button" className="absolute inset-0 z-10 cursor-default bg-[var(--app-backdrop)]" aria-label={t('common.cancel')} onClick={onCancel} />
    <section ref={dialog} id={`${titleId}-dialog`} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={`${titleId}-hint`} className="relative z-20 flex h-full max-h-[42rem] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border/20 bg-surface text-foreground shadow-xl">
      <header className="shrink-0 px-3 py-1"><div className="flex items-center gap-2"><h2 id={titleId} className="min-w-0 flex-1 text-sm font-semibold" title={t('architecture.browsePathsHint')}>{t('architecture.choosePaths')}</h2><button type="button" className={button} aria-label={t('common.close')} onClick={onCancel}><X size={17} /></button></div><p id={`${titleId}-hint`} className="sr-only">{t('architecture.browsePathsHint')}</p></header>
      <ArchitecturePathBrowser rootPath={rootPath} initialDirectory={initialDirectory} selected={selected} onChange={setSelected} />
      <footer className="shrink-0 space-y-2 border-t border-border/15 p-3"><p className="text-xs text-muted-foreground">{t('architecture.selectedPaths')} {selected.length} / 20</p>{selected.length > 0 && <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">{selected.map(path => <button type="button" key={path} className={`${button} min-w-0 max-w-full bg-surface-2`} aria-label={`${t('architecture.removePath')}: ${path}`} onClick={() => setSelected(previous => previous.filter(item => item !== path))}><span className="truncate font-mono">{path}</span><X size={13} className="shrink-0" /></button>)}</div>}<div className="flex justify-end gap-2"><button type="button" className={button} onClick={onCancel}>{t('common.cancel')}</button><button type="button" className={`${button} bg-primary/15 text-primary`} onClick={() => onConfirm(selected)}>{t('architecture.usePaths')}</button></div></footer>
    </section>
  </div>, document.body);
}
