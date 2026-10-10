import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Network, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { ARCHITECTURE_FILE, DEFAULT_ANALYSIS, architectureFileLabel, architectureScope, isArchitectureFile, ArchitectureFormatError, type ArchitectureField, type ArchitectureReference, type ArchitectureAnalysis, type ArchitectureDocument, type ArchitectureFile, type ArchitectureNode } from '../../architecture/model';
import { watchFileSystem } from '../../terminal/api';
import { architectureOverview } from '../../architecture/overview';
import { ArchitectureDocumentEditor } from './ArchitectureDocumentEditor';
import { ArchitectureDocumentFields } from './ArchitectureDocumentFields';
import { ArchitectureLibraryTools } from './ArchitectureLibraryTools';
import { listArchitectures, readArchitecture } from '../../architecture/api';
import { useI18n } from '../../i18n';
import { ArchitectureDiagram } from './ArchitectureDiagram';
import { ArchitectureGenerationForm } from './ArchitectureGenerationForm';
import { ArchitectureNodeDetail } from './ArchitectureNodeDetail';
import { ArchitectureInspector } from './ArchitectureInspector';
import { ArchitectureNodePreview } from './ArchitectureNodePreview';
import { useSidebarStore } from '../../stores/useSidebarStore';

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
  const currentFile = useSidebarStore(state => state.rootPath === rootPath ? state.selectedFilePath : null);
  const currentDirectory = useSidebarStore(state => state.rootPath === rootPath ? state.explorerRoot : null);
  const [file, setFile] = useState(() => savedSelection(rootPath));
  const [library, setLibrary] = useState<string[]>([]);
  const [libraryError, setLibraryError] = useState(false);
  const [preparedAnalysis, setPreparedAnalysis] = useState<ArchitectureAnalysis>(DEFAULT_ANALYSIS);
  const [generation, setGeneration] = useState<{ initial: ArchitectureAnalysis; outputFile?: string } | null>(null);
  const [document, setDocument] = useState<ArchitectureDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'format' | 'load' | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [perspectiveDocumentOpen, setPerspectiveDocumentOpen] = useState(false);
  const [allPerspectives, setAllPerspectives] = useState(false);
  const [perspectiveId, setPerspectiveId] = useState('');
  const [trail, setTrail] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodeHistory, setNodeHistory] = useState<string[]>([]);
  const [editor, setEditor] = useState<{ node?: string; field: ArchitectureField } | null>(null);
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
    setAllPerspectives(false); setPerspectiveId(''); setTrail([]); closeDetail(); setGeneration(null);
    setFile(savedSelection(rootPath)); setLibrary([]); setLibraryError(false); setPreparedAnalysis(DEFAULT_ANALYSIS);
    selectionChosen.current = hasSelection(rootPath);
  }, [rootPath]);

  useEffect(() => {
    setDocument(null); setError(null); setLoading(true);
    setAllPerspectives(false); setPerspectiveId(''); setTrail([]); closeDetail();
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

  const watchRoots = JSON.stringify(rootPath ? [...new Set([
    `${rootPath}/.termdock`, `${rootPath}/.termdock/architectures`, `${rootPath}/.omm`,
    ...(file === '.omm' ? document?.perspectives.flatMap(view => [`${rootPath}/.omm/${view.id}`, ...view.nodes.flatMap(node => node.documentPath ? [`${rootPath}/.omm/${node.documentPath}`] : [])]) ?? [] : []),
  ])].slice(0, 128).sort() : []);
  useEffect(() => {
    if (!active || !rootPath) return;
    const controller = new AbortController(); let debounce: ReturnType<typeof setTimeout> | undefined;
    void watchFileSystem(JSON.parse(watchRoots) as string[], events => {
      if (events.some(event => event.type === 'rescan-required' || event.path?.includes('/.omm/') || event.path?.includes('/.termdock/'))) {
        clearTimeout(debounce); debounce = setTimeout(() => setRefresh(value => value + 1), 300);
      }
    }, controller.signal).catch(() => { /* Saved-document polling remains active through watcher disconnections. */ });
    return () => { controller.abort(); clearTimeout(debounce); };
  }, [rootPath, active, watchRoots]);

  const view = document?.perspectives.find(view => view.id === perspectiveId) ?? document?.perspectives[0];
  const overview = useMemo(() => document ? architectureOverview(document, locale === 'zh' ? '全部视角' : 'All perspectives') : null, [document, locale]);
  const selectPerspective = (value: string) => { if (value === 'all-perspectives') { setAllPerspectives(true); navigate([]); } else { setAllPerspectives(false); setPerspectiveId(value); navigate([]); } };
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
  const selected = view?.nodes.find(node => node.id === selectedId);
  const parent = view?.nodes.find(node => node.id === parentId);
  const availableFiles = [...new Set([ARCHITECTURE_FILE, ...library, file])];
  const currentAnalysis = document?.analysis ?? (file === ARCHITECTURE_FILE || file === '.omm' ? DEFAULT_ANALYSIS : preparedAnalysis.kind === 'project' ? null : preparedAnalysis);
  const closeDetail = () => { setPerspectiveDocumentOpen(false); setEditor(null); setSelectedId(null); setDetailExpanded(false); setNodeHistory([]); setSourceFile(null); setModuleGeneration(null); setPreparedModuleFile(null); };
  const selectNode = (id: string, linked = false) => {
    setNodeHistory(history => linked && selectedId ? [...history, selectedId] : []);
    setDetailExpanded(linked);
    setPerspectiveDocumentOpen(false); setEditor(null); setSourceFile(null); setModuleGeneration(null); setPreparedModuleFile(null); setSelectedId(id);
  };
  const navigate = (next: string[]) => { if (next.length) setAllPerspectives(false); setTrail(next); closeDetail(); if (content.current) content.current.scrollTop = 0; };
  const openSource = (file: ArchitectureFile) => { if (renderSource) { setDetailExpanded(true); setSourceFile(file); } else onOpenFile(file); };
  const prepareModule = (node: ArchitectureNode) => {
    setModuleGeneration({ ...DEFAULT_ANALYSIS, kind: 'module', paths: [...new Set(node.files.map(source => source.path))].slice(0, 20) });
    setPreparedModuleFile(null);
  };
  const backDetail = editor ? () => setEditor(null) : sourceFile ? () => setSourceFile(null) : moduleGeneration ? () => setModuleGeneration(null) : nodeHistory.length ? () => {
    setSelectedId(nodeHistory[nodeHistory.length - 1]); setNodeHistory(history => history.slice(0, -1));
  } : undefined;
  const backLabel = sourceFile || moduleGeneration || editor ? t('architecture.backToModule') : t('architecture.previousModule');
  // Use the available workspace, rather than the device width, to choose a
  // reading layout. A narrow desktop sidebar needs the same room as a phone.
  const sideDetail = diagramExpanded ? wideViewport : panelWidth >= 900;
  const previewDetail = !sideDetail && !detailExpanded && !sourceFile && !moduleGeneration && !editor;
  const readingOnly = !diagramExpanded && (!!selected || perspectiveDocumentOpen) && (!!sourceFile || !!moduleGeneration || !!editor || mode === 'outline');
  const ancestry = (id: string): string[] => { const ids: string[] = []; let node = view?.nodes.find(node => node.id === id); while (node?.parentId) { ids.unshift(node.parentId); node = view?.nodes.find(item => item.id === node!.parentId); } return ids; };
  const referenceSelect = (reference: ArchitectureReference) => { const next = document?.perspectives.find(view => view.id === reference.perspective); if (!next) return; closeDetail(); setPerspectiveId(next.id); if (reference.node) { const ids: string[] = []; let node = next.nodes.find(node => node.id === reference.node); while (node?.parentId) { ids.unshift(node.parentId); node = next.nodes.find(item => item.id === node!.parentId); } setTrail(ids); setSelectedId(reference.node); setDetailExpanded(true); } else { setTrail([]); setPerspectiveDocumentOpen(true); } };
  const button = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-medium transition hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40';
  const dismissDetail = previewDetail ? closeDetail : backDetail ?? (!sideDetail && mode === 'graph' ? () => setDetailExpanded(false) : closeDetail);
  const inspector = (inGraph: boolean) => perspectiveDocumentOpen && view ? <ArchitectureInspector active={active} docked title={view.title} stageKey={`${view.id}:${editor ? 'edit' : 'view-document'}`} source={false} fullHeight={readingOnly || !!editor} inGraph={inGraph} side={sideDetail} onBack={editor ? () => setEditor(null) : undefined} backLabel={t('architecture.backToModule')} onClose={closeDetail} onDismiss={editor ? () => setEditor(null) : closeDetail}>
    {editor ? <ArchitectureDocumentEditor root={rootPath!} file={file} perspective={view.id} initialField={editor.field} onSaved={updated => { ++request.current; setDocument(updated); setEditor(null); setRefresh(value => value + 1); }} onCancel={() => setEditor(null)} /> : <><ArchitectureDocumentFields value={view} rootPath={rootPath} onEdit={field => setEditor({ field })} onOpenFile={onOpenFile} /><button type="button" className={`${button} text-primary`} onClick={() => { setAllPerspectives(false); navigate([]); }}>{locale === 'zh' ? '进入此视角' : 'Explore this perspective'}</button></>}
  </ArchitectureInspector> : selected && ((inGraph || mode === 'graph') && previewDetail
    ? <ArchitectureNodePreview node={selected} onExpand={() => setDetailExpanded(true)} onClose={closeDetail} />
    : <ArchitectureInspector active={active && !moduleGeneration} docked={!inGraph || (!sourceFile && !moduleGeneration)} title={selected.title} stageKey={`${selected.id}:${sourceFile ? `${sourceFile.path}:${sourceFile.line}` : moduleGeneration ? 'analysis' : editor ? `edit:${editor.field}` : 'details'}`} source={!!sourceFile} fullHeight={inGraph ? !!moduleGeneration || !!editor : readingOnly} inGraph={inGraph} side={sideDetail} onBack={backDetail} backLabel={backLabel} onClose={closeDetail} onDismiss={dismissDetail} onCollapse={!sideDetail && !readingOnly && !sourceFile && !moduleGeneration && !editor ? () => setDetailExpanded(false) : undefined}>
    {editor ? <ArchitectureDocumentEditor key={`${file}:${view!.id}:${editor.node ?? "view"}:${editor.field}`} root={rootPath!} file={file} perspective={view!.id} node={editor.node} initialField={editor.field} onSaved={updated => { ++request.current; setDocument(updated); setEditor(null); setRefresh(value => value + 1); }} onCancel={() => setEditor(null)} /> : sourceFile && renderSource ? renderSource(sourceFile) : moduleGeneration ? <>
      <ArchitectureGenerationForm active={active} key={selected.id} rootPath={rootPath!} currentFile={currentFile} currentDirectory={currentDirectory} initial={moduleGeneration} onInsertPrompt={onInsertPrompt} onPrepared={setPreparedModuleFile} onClose={() => setModuleGeneration(null)} />
      {preparedModuleFile && <button type="button" className={`${button} mt-3 bg-primary/15 text-primary`} onClick={() => { setPreparedAnalysis(moduleGeneration); selectFile(preparedModuleFile); closeDetail(); }}>{t('architecture.viewPrepared')}</button>}
    </> : <ArchitectureNodeDetail embedded document={document!} rootPath={rootPath} onReference={referenceSelect} onEdit={field => { setDetailExpanded(true); setEditor({ node: selected.id, field }); }} node={selected} view={view!} parentId={selected.parentId} onSelect={id => selectNode(id, true)} onExplore={() => navigate([...ancestry(selected.id), selected.id])} onAnalyze={() => prepareModule(selected)} onOpenFile={openSource} onClose={closeDetail} />}
  </ArchitectureInspector>);

  if (!rootPath) return <p className="p-5 text-sm text-muted-foreground">{t('fileTree.noWorkingDir')}</p>;
  return <div ref={panel} className="relative flex h-full min-h-0 flex-col" onKeyDown={event => {
    if (!diagramExpanded && (selected || perspectiveDocumentOpen) && event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing) {
      event.preventDefault(); event.stopPropagation(); dismissDetail();
    }
  }}>
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/15 px-3 py-2">
      <span className="flex items-center gap-2 text-sm font-semibold"><Network size={16} />{t('architecture.title')}</span>
      <div className="flex items-center gap-1">
        <button ref={generationTrigger} type="button" className={button} disabled={!currentAnalysis} onClick={() => { if (currentAnalysis) { closeDetail(); setGeneration(generation ? null : { initial: currentAnalysis, ...(document ? { outputFile: file } : {}) }); } }} aria-expanded={!!generation}><Sparkles size={14} />{t(document ? 'architecture.update' : 'architecture.generate')}</button>
        {(document || file !== ARCHITECTURE_FILE) && <button type="button" className={`${button} px-2`} aria-label={t('architecture.newAnalysis')} onClick={() => { closeDetail(); setGeneration({ initial: DEFAULT_ANALYSIS }); }}><Plus size={16} /></button>}
        <button type="button" className={`${button} px-2`} aria-label={t('architecture.refresh')} disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
      </div>
    </div>
    <div className={`relative flex min-h-0 flex-1 ${sideDetail && !readingOnly ? 'flex-row' : 'flex-col'}`} data-architecture-workspace>
    <div ref={content} hidden={readingOnly} data-architecture-content className={`min-h-0 min-w-0 flex-1 overflow-y-auto p-3 [overflow-anchor:none] ${generation ? 'flex flex-col' : ''}`}>
      {editor && !selected && !perspectiveDocumentOpen ? <div className="flex min-h-full flex-col gap-3"><h2 className="text-sm font-semibold">{view?.title}</h2><ArchitectureDocumentEditor key={`${file}:${view?.id}:${editor.field}`} root={rootPath} file={file} perspective={view!.id} initialField={editor.field} onSaved={updated => { ++request.current; setDocument(updated); setEditor(null); setRefresh(value => value + 1); }} onCancel={() => setEditor(null)} /></div> : generation ? <ArchitectureGenerationForm active={active} key={`${generation.outputFile ?? 'new'}:${JSON.stringify(generation.initial)}`} rootPath={rootPath} currentFile={currentFile} currentDirectory={currentDirectory} initial={generation.initial} outputFile={generation.outputFile} onInsertPrompt={onInsertPrompt} onPrepared={(nextFile, analysis) => { setPreparedAnalysis(analysis); selectFile(nextFile); }} onClose={closeGeneration} /> : <>
        <label className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">{t('architecture.savedAnalyses')}<select aria-label={t('architecture.savedAnalyses')} value={file} onChange={event => { setPreparedAnalysis(DEFAULT_ANALYSIS); selectFile(event.target.value); }} className="min-h-10 min-w-0 flex-1 rounded-lg border border-border/20 bg-surface-2 px-2 text-sm text-foreground">{availableFiles.map(path => <option key={path} value={path}>{path === '.omm' ? '.omm · oh-my-mermaid' : path === ARCHITECTURE_FILE ? t('architecture.projectRange') : `${t(path.includes('/module-') ? 'architecture.moduleRange' : 'architecture.featureRange')}: ${path === file && document?.analysis ? document.analysis.target.replace(/\n/g, ', ') : architectureFileLabel(path)}`}</option>)}</select></label>
        {libraryError && <p role="alert" className="mb-3 text-xs text-muted-foreground">{t('architecture.libraryFailed')}</p>}

        {loading && !document && <p role="status" className="py-4 text-sm text-muted-foreground">{t('architecture.loading')}</p>}
        {error && <div role="alert" className="mb-3 rounded-lg border border-destructive/30 p-3 text-sm"><p>{t(error === 'format' ? 'architecture.invalid' : 'architecture.loadFailed')}</p>{document && <p className="mt-1 text-xs text-muted-foreground">{t('architecture.previous')}</p>}<button type="button" className={`${button} mt-2 bg-surface-2`} onClick={() => setRefresh(value => value + 1)}>{t('architecture.retry')}</button></div>}
        {!loading && !error && !document && <div className="flex flex-col items-center gap-3 px-4 py-8 text-center"><Network size={32} className="text-muted-foreground" /><h2 className="text-base font-medium">{t('architecture.empty')}</h2><p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{t(file === ARCHITECTURE_FILE ? 'architecture.emptyHint' : 'architecture.awaitingFile')}</p></div>}
        {document && view && scope && <div className="space-y-3">
          {!currentAnalysis && <p className="text-xs text-muted-foreground">{t('architecture.scopeUnavailable')}</p>}
          {document.analysis && <p className="break-words text-xs text-muted-foreground">{t(`architecture.${document.analysis.kind}Range`)}{document.analysis.target ? ` · ${document.analysis.target.replace(/\n/g, ', ')}` : ''} · {t(document.analysis.depth === 'boundary' ? 'architecture.boundaryDepth' : 'architecture.followDepth')}</p>}
          {document.summary.length <= 240 && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{document.summary}</p>}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">{t('architecture.perspective')}<select aria-label={t('architecture.perspective')} value={allPerspectives ? 'all-perspectives' : view.id} onChange={event => selectPerspective(event.target.value)} className="min-h-11 min-w-0 flex-1 rounded-lg border border-border/20 bg-surface-2 px-2 text-sm text-foreground"><option value="all-perspectives">{locale === 'zh' ? '全部视角' : 'All perspectives'}</option>{document.perspectives.map(view => <option key={view.id} value={view.id}>{view.title}</option>)}</select></label>
          {validTrail.length > 0 && <nav className="flex flex-wrap items-center gap-1 text-xs" aria-label={t('architecture.breadcrumb')}><button type="button" className={`${button} px-2`} onClick={() => navigate([])}>{view.title}</button>{validTrail.map((id, index) => <span key={id} className="inline-flex items-center gap-1"><ChevronRight size={12} /><button type="button" className={`${button} px-2`} onClick={() => navigate(validTrail.slice(0, index + 1))}>{view.nodes.find(node => node.id === id)?.title}</button></span>)}</nav>}
          <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{parent?.summary ?? view.summary}</p>
          <details><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">{locale === 'zh' ? '视角文档与模块目录' : 'Perspective documents and module tree'}</summary><ArchitectureDocumentFields value={parent ?? view} rootPath={rootPath} onOpenFile={openSource} onEdit={field => { if (parent) { setSelectedId(parent.id); setDetailExpanded(true); setEditor({ node: parent.id, field }); } else setEditor({ field }); }} />
            <nav aria-label={locale === 'zh' ? '模块目录' : 'Module tree'} className="my-2 border-l border-border/20">{view.nodes.map(node => <button type="button" key={node.id} aria-label={`${locale === 'zh' ? '定位模块' : 'Go to module'}: ${node.title}`} className={`${button} flex w-full justify-start text-left ${selectedId === node.id ? 'text-primary' : ''}`} style={{ paddingInlineStart: 12 + ancestry(node.id).length * 16 }} onClick={() => { setTrail(ancestry(node.id)); selectNode(node.id); setDetailExpanded(true); }}>{node.title}</button>)}</nav>
          </details>
          <div role="group" aria-label={t('architecture.browseMode')} className="flex gap-1 rounded-lg bg-surface-2 p-1">{(['outline', 'graph'] as const).map(value => <button type="button" key={value} aria-pressed={mode === value} className={`${button} flex-1 ${mode === value ? 'bg-surface text-primary' : 'text-muted-foreground'}`} onClick={() => setDisplayMode(value)}>{t(value === 'outline' ? 'architecture.outlineMode' : 'architecture.graphMode')}</button>)}</div>
          {mode === 'graph' ? <>
            <ArchitectureDiagram view={allPerspectives && overview ? overview.view : view} parentId={allPerspectives ? undefined : parentId} selectedId={allPerspectives && overview ? [...overview.references].find(([, reference]) => reference.perspective === view.id && reference.node === selectedId)?.[0] ?? null : selectedId} onSelect={id => { if (allPerspectives && overview) { const reference = overview.references.get(id); if (reference) { referenceSelect(reference);  } } else selectNode(id); }} active={active} referenceWidth={panelWidth} inspector={inspector(true)} inspectorStage={sourceFile ? 'source' : moduleGeneration || editor ? 'analysis' : previewDetail ? 'preview' : 'details'} onDismissInspector={perspectiveDocumentOpen ? editor ? () => setEditor(null) : closeDetail : dismissDetail} onExpandedChange={expanded => { setDiagramExpanded(expanded); if (!expanded && diagramExpanded) closeDetail(); }} heading={<div className="relative"><select aria-label={t('architecture.perspective')} title={view.title} value={allPerspectives ? 'all-perspectives' : view.id} onChange={event => selectPerspective(event.target.value)} className="h-11 w-full min-w-0 appearance-none truncate bg-surface pr-4 text-xs font-semibold focus-visible:ring-2 focus-visible:ring-ring"><option value="all-perspectives">{locale === 'zh' ? '全部视角' : 'All perspectives'}</option>{document.perspectives.map(view => <option key={view.id} value={view.id}>{view.title}</option>)}</select><ChevronDown size={12} className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-muted-foreground" /></div>} navigation={validTrail.length > 0 ? <nav aria-label={t('architecture.breadcrumb')} className="flex items-center gap-1 px-2"><button type="button" className={`${button} shrink-0 px-2`} onClick={() => navigate(validTrail.slice(0, -1))}>{t('architecture.parentModule')}</button><span className="truncate text-xs text-muted-foreground">{view.title} / {parent?.title}</span></nav> : undefined} />
            <details><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">{t('architecture.modules')} ({scope.nodes.length})</summary><div className="flex flex-wrap gap-2">{scope.nodes.map(node => <button type="button" key={node.id} aria-pressed={selected?.id === node.id} className={`${button} bg-surface-2`} onClick={() => selectNode(node.id)}>{node.title}</button>)}</div></details>
          </> : <div className="space-y-2" role="group" aria-label={t('architecture.modules')}>
            {allPerspectives ? document.perspectives.map(perspective => <button key={perspective.id} type="button" className="block min-h-16 w-full rounded-xl bg-surface-2 p-3 text-left" onClick={() => selectPerspective(perspective.id)}><span className="text-sm font-medium">{perspective.title}</span><span className="mt-1 block text-xs text-muted-foreground">{perspective.summary}</span></button>) : scope.nodes.map(node => <div key={node.id}><button type="button" aria-label={node.title} aria-expanded={selected?.id === node.id} className="block min-h-16 w-full rounded-xl border border-border/20 bg-surface-2 p-3 text-left transition hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-ring" onClick={() => selectNode(node.id)}>
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
        <ArchitectureLibraryTools root={rootPath} file={file} document={document} onLoaded={(next, document) => { selectFile(next); setDocument(document); setRefresh(value => value + 1); }} />
      </>}
    </div>
    {active && !diagramExpanded && inspector(false)}
    </div>
  </div>;
}
