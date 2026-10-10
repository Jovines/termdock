import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Copy, FolderOpen, X } from 'lucide-react';
import { analysisFile, buildArchitecturePrompt, normalizeAnalysis, type ArchitectureAnalysis } from '../../architecture/model';
import { useKeyboardLayer } from '../../hooks/useKeyboardLayer';
import { useI18n } from '../../i18n';
import { parseScopePaths, relativeScopePath } from '../../architecture/scopePaths';
import { ArchitecturePathBrowser, ArchitecturePathPicker } from './ArchitecturePathPicker';

export function ArchitectureGenerationForm({ rootPath, initial, outputFile, currentFile, currentDirectory, active = true, onInsertPrompt, onPrepared, onClose }: {
  rootPath: string;
  initial: ArchitectureAnalysis;
  outputFile?: string;
  currentFile?: string | null;
  currentDirectory?: string | null;
  active?: boolean;
  onInsertPrompt: (prompt: string, source: HTMLElement) => boolean | Promise<boolean>;
  onPrepared: (file: string, analysis: ArchitectureAnalysis) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const form = useRef<HTMLFormElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  useKeyboardLayer(workspace, active, onClose);
  useLayoutEffect(() => { if (active) workspace.current?.scrollIntoView?.({ block: 'start' }); }, [active]);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = workspace.current;
    if (!active || !element) return;
    const measure = () => setWide(element.clientWidth >= 900);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
  const fieldId = useId();
  const [kind, setKind] = useState(initial.kind);
  const [target, setTarget] = useState(initial.target);
  const [paths, setPaths] = useState(initial.paths.join('\n'));
  const [depth, setDepth] = useState(initial.depth);
  const [focus, setFocus] = useState(initial.focus);
  const [feedback, setFeedback] = useState<'inserted' | 'copied' | 'failed' | 'insertFailed' | null>(null);
  const [pending, setPending] = useState(false);
  const [pickingPaths, setPickingPaths] = useState(false);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => { if (!active) { request.current++; setPending(false); setPickingPaths(false); } }, [active]);
  const parsedPaths = parseScopePaths(paths, rootPath);
  const currentPath = currentFile ? relativeScopePath(currentFile, rootPath) : null;
  const currentFolder = currentDirectory ? relativeScopePath(currentDirectory, rootPath) : null;
  const browseDirectory = currentFolder ? currentDirectory : currentPath ? currentFile!.slice(0, currentFile!.lastIndexOf('/')) : rootPath;
  const adjacentBrowser = active && wide && kind !== 'project' && !outputFile;
  // If a draft chooser is already open, keep its explicit confirm/cancel flow on resize.
  const showBrowser = adjacentBrowser && !pickingPaths;
  let scope: ArchitectureAnalysis | null = null;
  try { if (kind === 'project' || parsedPaths) scope = normalizeAnalysis({ kind, target, paths: parsedPaths ?? [], depth, focus }); } catch { /* validated below */ }
  const prompt = scope ? buildArchitecturePrompt(rootPath, locale, scope, outputFile) : '';
  const buttonBase = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40';
  const button = `${buttonBase} px-3`;
  const scopeButton = `${buttonBase} px-1`;
  const field = 'min-h-10 w-full min-w-0 rounded-lg border border-border/20 bg-surface px-2 py-2 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring';
  const change = () => { request.current++; setPending(false); setFeedback(null); };
  const appendPath = (path: string) => { setPaths(parsedPaths ? [...new Set([...parsedPaths, path])].join('\n') : `${paths.trim()}\n${path}`); change(); };
  const prepared = scope;
  return <div ref={workspace} id={`${fieldId}-workspace`} tabIndex={-1} className={showBrowser ? 'grid min-w-0 grid-cols-[minmax(0,1fr)_20rem] items-start gap-3' : 'min-w-0'}><form ref={form} tabIndex={-1} className="min-w-0 space-y-2.5 rounded-xl border border-border/20 bg-surface-2 p-3" onSubmit={event => {
    event.preventDefault();
    if (!prepared || pending || !active || !form.current) return;
    const revision = ++request.current;
    const source = form.current;
    // Disabling the focused submit button otherwise drops browser focus to body.
    source.focus({ preventScroll: true });
    setPending(true); setFeedback(null);
    void Promise.resolve().then(() => revision === request.current && source.isConnected ? onInsertPrompt(prompt, source) : false).then(ok => {
      if (revision !== request.current) return;
      if (ok === true) { onPrepared(outputFile ?? analysisFile(prepared), prepared); setFeedback('inserted'); }
      else setFeedback('insertFailed');
    }).catch(() => { if (revision === request.current) setFeedback('insertFailed'); })
      .finally(() => { if (revision === request.current) setPending(false); });
  }}>
    <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-medium">{t(outputFile ? 'architecture.updateAnalysis' : 'architecture.prepare')}</h2><button type="button" className={`${button} px-2`} aria-label={t('architecture.closePreparation')} onClick={onClose}><X size={16} /></button></div>
    <label className="block space-y-1 text-xs" htmlFor={`${fieldId}-kind`}><span>{t('architecture.analysisRange')}</span><select id={`${fieldId}-kind`} className={field} value={kind} disabled={!!outputFile} onChange={event => { setKind(event.target.value as ArchitectureAnalysis['kind']); change(); }}>
      <option value="project">{t('architecture.projectRange')}</option><option value="module">{t('architecture.moduleRange')}</option><option value="feature">{t('architecture.featureRange')}</option>
    </select></label>
    {kind === 'feature' && <label className="block space-y-1 text-xs" htmlFor={`${fieldId}-target`}><span>{t('architecture.featureTarget')}</span><input id={`${fieldId}-target`} className={field} value={target} readOnly={!!outputFile} maxLength={1000} placeholder={t('architecture.featurePlaceholder')} onChange={event => { setTarget(event.target.value); change(); }} aria-describedby={`${fieldId}-validation`} /></label>}
    {kind !== 'project' && <div className="space-y-1">
      <label className="block text-xs" htmlFor={`${fieldId}-paths`}>{t(kind === 'module' ? 'architecture.modulePaths' : 'architecture.startPaths')}</label>
      <textarea id={`${fieldId}-paths`} className={`${field} resize-y font-mono text-xs`} rows={2} value={paths} readOnly={!!outputFile} placeholder={t('architecture.modulePlaceholder')} onChange={event => { setPaths(event.target.value); change(); }} onBlur={() => { if (!outputFile && parsedPaths) setPaths(parsedPaths.join('\n')); }} onPaste={event => {
        if (outputFile) return;
        const incoming = parseScopePaths(event.clipboardData.getData('text/plain'), rootPath);
        if (!incoming?.length || !parsedPaths) return;
        const next = [...new Set([...parsedPaths, ...incoming])];
        if (next.length > 20) return;
        event.preventDefault(); setPaths(next.join('\n')); change();
      }} aria-describedby={`${fieldId}-paths-hint ${fieldId}-validation`} />
      {!outputFile && <div className="flex flex-wrap gap-1">{!showBrowser && <button type="button" className={`${scopeButton} text-primary`} aria-label={t('architecture.choosePaths')} onClick={() => setPickingPaths(true)}><FolderOpen size={14} />{t('architecture.browsePaths')}</button>}{currentFolder && <button type="button" className={scopeButton} disabled={!!parsedPaths?.includes(currentFolder) || (parsedPaths?.length ?? 0) >= 20} title={currentFolder} onClick={() => appendPath(currentFolder)}>{t('architecture.useCurrentDirectory')}</button>}{currentPath && <button type="button" className={scopeButton} disabled={!!parsedPaths?.includes(currentPath) || (parsedPaths?.length ?? 0) >= 20} title={currentPath} onClick={() => appendPath(currentPath)}>{t('architecture.useCurrentFile')}</button>}</div>}
      <p id={`${fieldId}-paths-hint`} className="text-xs leading-relaxed text-muted-foreground" title={rootPath}>{t('architecture.pathsHint')}</p>
    </div>}
    {!scope && (paths.trim() || target.trim()) && <p id={`${fieldId}-validation`} role="alert" className="text-xs text-muted-foreground">{t(kind === 'module' ? 'architecture.invalidPaths' : 'architecture.requiredFeature')}</p>}
    <label className="block space-y-1 text-xs" htmlFor={`${fieldId}-focus`}><span>{t('architecture.focus')}</span><textarea id={`${fieldId}-focus`} className={`${field} resize-y`} rows={2} maxLength={2000} value={focus} placeholder={t('architecture.focusPlaceholder')} onChange={event => { setFocus(event.target.value); change(); }} /></label>
    <div className="flex flex-wrap gap-2">
      <button type="submit" disabled={!scope || pending} className={`${button} bg-primary/15 text-primary`}>{t(pending ? 'architecture.inserting' : 'architecture.insertPrompt')}</button>
      <button type="button" disabled={!scope || pending} className={button} onClick={() => {
        if (!prepared) return;
        const revision = ++request.current;
        void Promise.resolve().then(() => navigator.clipboard.writeText(prompt)).then(() => { if (revision !== request.current) return; onPrepared(outputFile ?? analysisFile(prepared), prepared); setFeedback('copied'); }).catch(() => { if (revision === request.current) setFeedback('failed'); });
      }}><Copy size={14} />{t('architecture.copyPrompt')}</button>
    </div>
    {feedback && <p role="status" className="text-xs text-muted-foreground">{t(`architecture.${feedback}`)}</p>}
    <details><summary className="cursor-pointer py-2 text-xs text-muted-foreground">{t('architecture.analysisOptions')}</summary><div className="space-y-3 pt-1">
      <label className="block space-y-1 text-xs" htmlFor={`${fieldId}-depth`}><span>{t('architecture.dependencyDepth')}</span><select id={`${fieldId}-depth`} className={field} value={depth} onChange={event => { setDepth(event.target.value as ArchitectureAnalysis['depth']); change(); }}><option value="boundary">{t('architecture.boundaryDepth')}</option><option value="dependencies">{t('architecture.followDepth')}</option></select></label>
      {kind === 'feature' && <p className="text-xs leading-relaxed text-muted-foreground">{t('architecture.featureScopeHint')}</p>}
      <p className="text-xs leading-relaxed text-muted-foreground">{t(outputFile ? 'architecture.updateOnly' : 'architecture.independentHint')}</p>
    </div></details>
    <details><summary className="cursor-pointer py-2 text-xs text-muted-foreground">{t('architecture.previewPrompt')}</summary><textarea readOnly aria-label={t('architecture.previewPrompt')} value={prompt} className={`${field} mt-2 h-52 resize-y font-mono text-xs`} /></details>
    <p className="text-xs leading-relaxed text-muted-foreground">{t('architecture.promptHint')}</p>
  </form>
    {showBrowser && <section aria-label={t('architecture.choosePaths')} className="flex h-[32rem] max-h-[calc(100dvh-15rem)] min-h-72 min-w-0 flex-col overflow-hidden rounded-xl border border-border/20 bg-surface-2">
      <header className="shrink-0 space-y-1 border-b border-border/15 p-3"><h3 className="text-sm font-medium">{t('architecture.choosePaths')}</h3><p className="text-xs leading-relaxed text-muted-foreground">{t('architecture.browsePathsHint')}</p><p role="status" className="text-xs text-muted-foreground">{t('architecture.selectedPaths')} {parsedPaths?.length ?? 0} / 20</p></header>
      <ArchitecturePathBrowser rootPath={rootPath} initialDirectory={browseDirectory} selected={parsedPaths ?? []} selectionDisabled={!parsedPaths} onChange={next => { setPaths(next.join('\n')); change(); }} />
    </section>}
    {active && pickingPaths && <ArchitecturePathPicker rootPath={rootPath} initialDirectory={browseDirectory} initial={parsedPaths ?? []} onCancel={() => setPickingPaths(false)} onConfirm={next => { setPaths(next.join('\n')); setPickingPaths(false); change(); }} />}
  </div>;
}
