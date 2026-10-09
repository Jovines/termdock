import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Network, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { ARCHITECTURE_FILE, DEFAULT_ANALYSIS, architectureFileLabel, architectureScope, isArchitectureFile, ArchitectureFormatError, type ArchitectureAnalysis, type ArchitectureDocument, type ArchitectureFile, type ArchitectureNode } from '../../architecture/model';
import { listArchitectures, readArchitecture } from '../../architecture/api';
import { useI18n } from '../../i18n';
import { ArchitectureDiagram } from './ArchitectureDiagram';
import { ArchitectureGenerationForm } from './ArchitectureGenerationForm';
import { ArchitectureNodeDetail } from './ArchitectureNodeDetail';
import { ArchitectureInspector } from './ArchitectureInspector';
import { ArchitectureNodePreview } from './ArchitectureNodePreview';

function selectionKey(root: string): string { return `termdock.architecture.selection:${root}`; }
function savedSelection(root: string | null): string {
  try {
    const value = root ? sessionStorage.getItem(selectionKey(root)) : null;
    return value && isArchitectureFile(value) ? value : ARCHITECTURE_FILE;
  } catch { return ARCHITECTURE_FILE; }
}
function hasSelection(root: string | null): boolean {
  try { const file = root ? sessionStorage.getItem(selectionKey(root)) : null; return !!file && isArchitectureFile(file); } catch { return false; }
}

export function ArchitecturePanel({ rootPath, active, onInsertPrompt, onOpenFile, renderSource }: {
  rootPath: string | null;
  active: boolean;
  onInsertPrompt: (prompt: string, source: HTMLElement) => boolean | Promise<boolean>;
  onOpenFile: (file: ArchitectureFile) => void;
  renderSource?: (file: ArchitectureFile) => ReactNode;
}) {
  const { t, locale } = useI18n();
  const [file, setFile] = useState(() => savedSelection(rootPath));
  const [library, setLibrary] = useState<string[]>([]);
  const [libraryError, setLibraryError] = useState(false);
  const [preparedAnalysis, setPreparedAnalysis] = useState<ArchitectureAnalysis>(DEFAULT_ANALYSIS);
  const [generation, setGeneration] = useState<{ initial: ArchitectureAnalysis; outputFile?: string } | null>(null);
  const [document, setDocument] = useState<ArchitectureDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'format' | 'load' | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [perspectiveId, setPerspectiveId] = useState('');
  const [trail, setTrail] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodeHistory, setNodeHistory] = useState<string[]>([]);
  const [sourceFile, setSourceFile] = useState<ArchitectureFile | null>(null);
  const [moduleGeneration, setModuleGeneration] = useState<ArchitectureAnalysis | null>(null);
  const [preparedModuleFile, setPreparedModuleFile] = useState<string | null>(null);
  const [diagramExpanded, setDiagramExpanded] = useState(false);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [wideViewport, setWideViewport] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768);
  const request = useRef(0);
  const selectionChosen = useRef(hasSelection(rootPath));
  const panel = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(0);
  const [displayMode, setDisplayMode] = useState<'auto' | 'outline' | 'graph'>('auto');
  const mode = displayMode === 'auto' ? (panelWidth >= 560 ? 'graph' : 'outline') : displayMode;
  const generationTrigger = useRef<HTMLButtonElement>(null);
  const selectFile = (next: string) => {
    selectionChosen.current = true;
    setFile(next);
    // The page's Storage wrapper already isolates state by target service.
    try { if (rootPath) sessionStorage.setItem(selectionKey(rootPath), next); } catch { /* browsing works without storage */ }
  };
  const closeGeneration = () => { setGeneration(null); generationTrigger.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    const resize = () => setWideViewport(window.innerWidth >= 768);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    const element = panel.current;
    if (!element || !active || typeof ResizeObserver === 'undefined') return;
    const measure = () => { if (element.clientWidth > 0) setPanelWidth(element.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [active]);

  useEffect(() => {
    setDocument(null); setError(null); setLoading(true);
    setPerspectiveId(''); setTrail([]); closeDetail(); setGeneration(null);
    setFile(savedSelection(rootPath)); setLibrary([]); setLibraryError(false); setPreparedAnalysis(DEFAULT_ANALYSIS);
    selectionChosen.current = hasSelection(rootPath);
  }, [rootPath]);

  useEffect(() => {
    setDocument(null); setError(null); setLoading(true);
    setPerspectiveId(''); setTrail([]); closeDetail();
  }, [file]);

  useEffect(() => {
    if (!active || !rootPath) return;
    let disposed = false;
    let current: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (initial: boolean) => {
      const version = ++request.current;
      const controller = new AbortController();
      current = controller;
      if (initial) { setLoading(true); setError(null); }
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const [result, maps] = await Promise.allSettled([readArchitecture(rootPath, controller.signal, file), listArchitectures(rootPath, controller.signal)]);
        if (disposed || request.current !== version) return;
        if (maps.status === 'fulfilled') { setLibrary(maps.value); setLibraryError(false); }
        else setLibraryError(true);
        if (result.status === 'rejected') throw result.reason;
        setDocument(previous => JSON.stringify(previous) === JSON.stringify(result.value) ? previous : result.value);
        setError(null);
        // A fresh client should show the sole saved feature/module map, even
        // when this project intentionally has no full overview.
        if (!result.value && file === ARCHITECTURE_FILE && !selectionChosen.current
          && maps.status === 'fulfilled' && maps.value.length === 1) selectFile(maps.value[0]);
      } catch (reason) {
        if (disposed || request.current !== version) return;
        setError(reason instanceof ArchitectureFormatError ? 'format' : 'load');
      } finally {
        window.clearTimeout(timeout);
        if (!disposed && request.current === version) {
          setLoading(false);
          // Only observe the saved file; this never infers the Agent's progress.
          timer = setTimeout(() => { if (!disposed) void load(false); }, 10_000);
        }
      }
    };
    void load(true);
    return () => { disposed = true; ++request.current; current?.abort(); clearTimeout(timer); };
  }, [rootPath, active, refresh, file]);

  const view = document?.perspectives.find(view => view.id === perspectiveId) ?? document?.perspectives[0];
  const validTrail = useMemo(() => {
    const valid: string[] = [];
    for (const id of trail) {
      if (!view?.nodes.some(node => node.id === id && node.parentId === valid[valid.length - 1])) break;
      valid.push(id);
    }
    return valid;
  }, [trail, view]);
  const parentId = validTrail[validTrail.length - 1];
  const scope = useMemo(() => view ? architectureScope(view, parentId) : null, [view, parentId]);
  const selected = scope?.nodes.find(node => node.id === selectedId);
  const parent = view?.nodes.find(node => node.id === parentId);
  const availableFiles = [...new Set([ARCHITECTURE_FILE, ...library, file])];
  const currentAnalysis = document?.analysis ?? (file === ARCHITECTURE_FILE ? DEFAULT_ANALYSIS : preparedAnalysis.kind === 'project' ? null : preparedAnalysis);
  const closeDetail = () => { setSelectedId(null); setDetailExpanded(false); setNodeHistory([]); setSourceFile(null); setModuleGeneration(null); setPreparedModuleFile(null); };
  const selectNode = (id: string, linked = false) => {
    setNodeHistory(history => linked && selectedId ? [...history, selectedId] : []);
    setDetailExpanded(linked);
    setSourceFile(null); setModuleGeneration(null); setPreparedModuleFile(null); setSelectedId(id);
  };
  const navigate = (next: string[]) => { setTrail(next); closeDetail(); if (content.current) content.current.scrollTop = 0; };
  const openSource = (file: ArchitectureFile) => { if (renderSource) { setDetailExpanded(true); setSourceFile(file); } else onOpenFile(file); };
  const prepareModule = (node: ArchitectureNode) => {
    setModuleGeneration({ ...DEFAULT_ANALYSIS, kind: 'module', paths: [...new Set(node.files.map(source => source.path))].slice(0, 20) });
    setPreparedModuleFile(null);
  };
  const backDetail = sourceFile ? () => setSourceFile(null) : moduleGeneration ? () => setModuleGeneration(null) : nodeHistory.length ? () => {
    setSelectedId(nodeHistory[nodeHistory.length - 1]); setNodeHistory(history => history.slice(0, -1));
  } : undefined;
  const backLabel = sourceFile || moduleGeneration ? t('architecture.backToModule') : t('architecture.previousModule');
  const previewDetail = !wideViewport && !detailExpanded && !sourceFile && !moduleGeneration;
  const button = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-medium transition hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40';
  const inspector = (inGraph: boolean) => selected && (inGraph && previewDetail
    ? <ArchitectureNodePreview node={selected} onExpand={() => setDetailExpanded(true)} onClose={closeDetail} />
    : <ArchitectureInspector active={active && !moduleGeneration} docked={inGraph && !sourceFile && !moduleGeneration} title={selected.title} stageKey={`${selected.id}:${sourceFile ? `${sourceFile.path}:${sourceFile.line}` : moduleGeneration ? 'analysis' : 'details'}`} source={!!sourceFile} fullHeight={!!moduleGeneration} inGraph={inGraph} side={!sourceFile && mode === 'graph' && panelWidth >= 680} onBack={backDetail} backLabel={backLabel} onClose={closeDetail} onDismiss={backDetail ?? closeDetail} onCollapse={inGraph && !wideViewport && !sourceFile && !moduleGeneration ? () => setDetailExpanded(false) : undefined}>
    {sourceFile && renderSource ? renderSource(sourceFile) : moduleGeneration ? <>
      <ArchitectureGenerationForm active={active} key={selected.id} rootPath={rootPath!} initial={moduleGeneration} onInsertPrompt={onInsertPrompt} onPrepared={setPreparedModuleFile} onClose={() => setModuleGeneration(null)} />
      {preparedModuleFile && <button type="button" className={`${button} mt-3 bg-primary/15 text-primary`} onClick={() => { setPreparedAnalysis(moduleGeneration); selectFile(preparedModuleFile); closeDetail(); }}>{t('architecture.viewPrepared')}</button>}
    </> : <ArchitectureNodeDetail embedded node={selected} view={view!} parentId={parentId} onSelect={id => selectNode(id, true)} onExplore={() => navigate([...validTrail, selected.id])} onAnalyze={() => prepareModule(selected)} onOpenFile={openSource} onClose={closeDetail} />}
  </ArchitectureInspector>);

  if (!rootPath) return <p className="p-5 text-sm text-muted-foreground">{t('fileTree.noWorkingDir')}</p>;
  return <div ref={panel} className="relative flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/15 px-3 py-2">
      <span className="flex items-center gap-2 text-sm font-semibold"><Network size={16} />{t('architecture.title')}</span>
      <div className="flex items-center gap-1">
        <button ref={generationTrigger} type="button" className={button} disabled={!currentAnalysis} onClick={() => { if (currentAnalysis) setGeneration(generation ? null : { initial: currentAnalysis, ...(document ? { outputFile: file } : {}) }); }} aria-expanded={!!generation}><Sparkles size={14} />{t(document ? 'architecture.update' : 'architecture.generate')}</button>
        {(document || file !== ARCHITECTURE_FILE) && <button type="button" className={`${button} px-2`} aria-label={t('architecture.newAnalysis')} onClick={() => setGeneration({ initial: DEFAULT_ANALYSIS })}><Plus size={16} /></button>}
        <button type="button" className={`${button} px-2`} aria-label={t('architecture.refresh')} disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
      </div>
    </div>
    <div ref={content} className="min-h-0 flex-1 overflow-y-auto p-3 [overflow-anchor:none]">
      {generation ? <ArchitectureGenerationForm active={active} key={`${generation.outputFile ?? 'new'}:${JSON.stringify(generation.initial)}`} rootPath={rootPath} initial={generation.initial} outputFile={generation.outputFile} onInsertPrompt={onInsertPrompt} onPrepared={(nextFile, analysis) => { setPreparedAnalysis(analysis); selectFile(nextFile); }} onClose={closeGeneration} /> : <>
        <label className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">{t('architecture.savedAnalyses')}<select aria-label={t('architecture.savedAnalyses')} value={file} onChange={event => { setPreparedAnalysis(DEFAULT_ANALYSIS); selectFile(event.target.value); }} className="min-h-10 min-w-0 flex-1 rounded-lg border border-border/20 bg-surface-2 px-2 text-sm text-foreground">{availableFiles.map(path => <option key={path} value={path}>{path === ARCHITECTURE_FILE ? t('architecture.projectRange') : `${t(path.includes('/module-') ? 'architecture.moduleRange' : 'architecture.featureRange')}: ${path === file && document?.analysis ? document.analysis.target.replace(/\n/g, ', ') : architectureFileLabel(path)}`}</option>)}</select></label>
        {libraryError && <p role="alert" className="mb-3 text-xs text-muted-foreground">{t('architecture.libraryFailed')}</p>}

        {loading && !document && <p role="status" className="py-4 text-sm text-muted-foreground">{t('architecture.loading')}</p>}
        {error && <div role="alert" className="mb-3 rounded-lg border border-destructive/30 p-3 text-sm"><p>{t(error === 'format' ? 'architecture.invalid' : 'architecture.loadFailed')}</p>{document && <p className="mt-1 text-xs text-muted-foreground">{t('architecture.previous')}</p>}<button type="button" className={`${button} mt-2 bg-surface-2`} onClick={() => setRefresh(value => value + 1)}>{t('architecture.retry')}</button></div>}
        {!loading && !error && !document && <div className="flex flex-col items-center gap-3 px-4 py-8 text-center"><Network size={32} className="text-muted-foreground" /><h2 className="text-base font-medium">{t('architecture.empty')}</h2><p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{t(file === ARCHITECTURE_FILE ? 'architecture.emptyHint' : 'architecture.awaitingFile')}</p></div>}
        {document && view && scope && <div className="space-y-3">
          {!currentAnalysis && <p className="text-xs text-muted-foreground">{t('architecture.scopeUnavailable')}</p>}
          {document.analysis && <p className="break-words text-xs text-muted-foreground">{t(`architecture.${document.analysis.kind}Range`)}{document.analysis.target ? ` · ${document.analysis.target.replace(/\n/g, ', ')}` : ''} · {t(document.analysis.depth === 'boundary' ? 'architecture.boundaryDepth' : 'architecture.followDepth')}</p>}
          {document.summary.length <= 240 && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{document.summary}</p>}
          {/* Cover the scroll container's padding without a space-y gap above the sticky background. */}
          <label className="sticky -top-3 z-10 !mt-0 -mx-3 flex items-center gap-2 bg-surface px-3 py-2 text-xs text-muted-foreground">{t('architecture.perspective')}<select aria-label={t('architecture.perspective')} value={view.id} onChange={event => { setPerspectiveId(event.target.value); navigate([]); }} className="min-h-11 min-w-0 flex-1 rounded-lg border border-border/20 bg-surface-2 px-2 text-sm text-foreground">{document.perspectives.map(view => <option key={view.id} value={view.id}>{view.title}</option>)}</select></label>
          {validTrail.length > 0 && <nav className="flex flex-wrap items-center gap-1 text-xs" aria-label={t('architecture.breadcrumb')}><button type="button" className={`${button} px-2`} onClick={() => navigate([])}>{view.title}</button>{validTrail.map((id, index) => <span key={id} className="inline-flex items-center gap-1"><ChevronRight size={12} /><button type="button" className={`${button} px-2`} onClick={() => navigate(validTrail.slice(0, index + 1))}>{view.nodes.find(node => node.id === id)?.title}</button></span>)}</nav>}
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{parent?.summary ?? view.summary}</p>
          <div role="group" aria-label={t('architecture.browseMode')} className="flex gap-1 rounded-lg bg-surface-2 p-1">{(['outline', 'graph'] as const).map(value => <button type="button" key={value} aria-pressed={mode === value} className={`${button} flex-1 ${mode === value ? 'bg-surface text-primary' : 'text-muted-foreground'}`} onClick={() => setDisplayMode(value)}>{t(value === 'outline' ? 'architecture.outlineMode' : 'architecture.graphMode')}</button>)}</div>
          {mode === 'graph' ? <>
            <ArchitectureDiagram view={view} parentId={parentId} selectedId={selectedId} onSelect={selectNode} active={active} inspector={inspector(true)} inspectorStage={sourceFile ? 'source' : moduleGeneration ? 'analysis' : previewDetail ? 'preview' : 'details'} onDismissInspector={previewDetail ? closeDetail : backDetail ?? (!wideViewport ? () => setDetailExpanded(false) : closeDetail)} onExpandedChange={expanded => { setDiagramExpanded(expanded); if (!expanded) closeDetail(); }} heading={<div className="relative"><select aria-label={t('architecture.perspective')} title={view.title} value={view.id} onChange={event => { setPerspectiveId(event.target.value); navigate([]); }} className="h-11 w-full min-w-0 appearance-none truncate bg-surface pr-4 text-xs font-semibold focus-visible:ring-2 focus-visible:ring-ring">{document.perspectives.map(view => <option key={view.id} value={view.id}>{view.title}</option>)}</select><ChevronDown size={12} className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-muted-foreground" /></div>} navigation={validTrail.length > 0 ? <nav aria-label={t('architecture.breadcrumb')} className="flex items-center gap-1 px-2"><button type="button" className={`${button} shrink-0 px-2`} onClick={() => navigate(validTrail.slice(0, -1))}>{t('architecture.parentModule')}</button><span className="truncate text-xs text-muted-foreground">{view.title} / {parent?.title}</span></nav> : undefined} />
            <details><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">{t('architecture.modules')} ({scope.nodes.length})</summary><div className="flex flex-wrap gap-2">{scope.nodes.map(node => <button type="button" key={node.id} aria-pressed={selected?.id === node.id} className={`${button} bg-surface-2`} onClick={() => selectNode(node.id)}>{node.title}</button>)}</div></details>
          </> : <div className="space-y-2" role="group" aria-label={t('architecture.modules')}>
            {scope.nodes.map(node => <div key={node.id}><button type="button" aria-label={node.title} aria-expanded={selected?.id === node.id} className="block min-h-16 w-full rounded-xl border border-border/20 bg-surface-2 p-3 text-left transition hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-ring" onClick={() => selectNode(node.id)}>
              <span className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{node.title}</span><ChevronRight size={16} className="shrink-0 text-muted-foreground" /></span>
              <span className="mt-1.5 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">{node.summary}</span>
            </button></div>)}
          </div>}
          <details className="rounded-lg border border-border/15 px-3"><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">{t('architecture.analysisNotes')} · {t('architecture.savedAt')} {new Date(document.generatedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</summary>
            <div className="space-y-3 pb-3">
              {document.summary.length > 240 && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{document.summary}</p>}
              {document.details?.limitations.length ? <div><h3 className="mb-1 text-xs font-semibold">{t('architecture.limitations')}</h3><ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">{document.details.limitations.map((note, i) => <li key={i}>{note}</li>)}</ul></div> : null}
              {document.details?.analyzedPaths.length ? <details><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">{t('architecture.analyzedPaths')} ({document.details.analyzedPaths.length})</summary>{document.details.analyzedPaths.map(path => <button type="button" key={path} className="block min-h-11 w-full break-all rounded px-2 py-2 text-left font-mono text-xs text-primary hover:bg-surface-elevated" onClick={() => onOpenFile({ path })}>{path}</button>)}</details> : null}
            </div>
          </details>
          {parent && parent.files.length > 0 && <details><summary className="cursor-pointer py-2 text-xs text-muted-foreground">{t('architecture.sourceFiles')}</summary>{parent.files.map(file => <button type="button" key={`${file.path}:${file.line ?? ''}`} className="block min-h-10 w-full break-all rounded px-2 py-2 text-left font-mono text-xs text-primary hover:bg-surface-2" onClick={() => onOpenFile(file)}>{file.path}{file.line ? `:${file.line}` : ''}</button>)}</details>}
        </div>}
      </>}
    </div>
    {active && !diagramExpanded && inspector(false)}
  </div>;
}
