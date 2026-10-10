import { ArrowDownLeft, ArrowUpRight, ChevronRight, Sparkles, X } from 'lucide-react';
import { architectureScope, type ArchitectureDocument, type ArchitectureField, type ArchitectureReference, type ArchitectureFile, type ArchitectureNode, type ArchitecturePerspective } from '../../architecture/model';
import { ArchitectureDocumentFields } from './ArchitectureDocumentFields';
import { useI18n } from '../../i18n';

export function ArchitectureNodeDetail({ node, view, parentId, onSelect, onExplore, onAnalyze, onOpenFile, onClose, document, rootPath, onEdit, onReference, embedded = false }: {
  document?: ArchitectureDocument;
  rootPath?: string | null;
  onEdit?: (field: ArchitectureField) => void;
  onReference?: (reference: ArchitectureReference) => void;
  node: ArchitectureNode;
  view: ArchitecturePerspective;
  parentId?: string;
  onSelect: (id: string) => void;
  onExplore: () => void;
  onAnalyze: () => void;
  onOpenFile: (file: ArchitectureFile) => void;
  onClose: () => void;
  embedded?: boolean;
}) {
  const { t, locale } = useI18n();
  const references = [...(node.references ?? []), ...(document?.perspectives.flatMap(perspective => perspective.nodes.filter(other => other.references?.some(ref => ref.perspective === view.id && (!ref.node || ref.node === node.id))).map(other => ({ perspective: perspective.id, node: other.id }))) ?? [])];
  const scope = architectureScope(view, parentId);
  const connections = scope.edges.filter(edge => edge.from === node.id || edge.to === node.id);
  const button = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-medium transition hover:bg-surface-elevated focus-visible:ring-2 focus-visible:ring-ring';
  return <section className={embedded ? 'space-y-3' : 'space-y-3 rounded-xl border border-primary/30 bg-surface-2 p-3'} aria-label={node.title}>
    {!embedded && <div className="flex items-start justify-between gap-2"><h3 className="pt-2 text-sm font-semibold">{node.title}</h3><button type="button" className={`${button} shrink-0 px-2`} aria-label={t('architecture.closeDetail')} onClick={onClose}><X size={16} /></button></div>}
    <>{!node.description && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{node.summary}</p>}<ArchitectureDocumentFields value={node} rootPath={rootPath} onEdit={onEdit} onOpenFile={onOpenFile} /></>
    <div className="flex flex-wrap gap-2">
      {view.nodes.some(child => child.parentId === node.id) && <button type="button" className={`${button} bg-primary/15 text-primary`} onClick={onExplore}>{t('architecture.explore')}<ChevronRight size={14} /></button>}
      {node.files.length > 0 && <button type="button" className={`${button} text-primary`} onClick={onAnalyze}><Sparkles size={14} />{t('architecture.analyzeModule')}</button>}
    </div>
    {references.length > 0 && <div><h4 className="text-xs font-semibold text-muted-foreground">{locale === 'zh' ? '跨视角引用' : 'Cross-perspective references'}</h4>{references.map((ref, index) => <button type="button" key={index} aria-label={`${locale === 'zh' ? '打开引用' : 'Open reference'}: ${document?.perspectives.find(view => view.id === ref.perspective)?.nodes.find(node => node.id === ref.node)?.title ?? document?.perspectives.find(view => view.id === ref.perspective)?.title ?? ref.perspective}`} className={`${button} block w-full text-left text-primary`} onClick={() => onReference?.(ref)}>{document?.perspectives.find(view => view.id === ref.perspective)?.nodes.find(node => node.id === ref.node)?.title ?? document?.perspectives.find(view => view.id === ref.perspective)?.title ?? ref.perspective}<ChevronRight size={14} /></button>)}</div>}
    {connections.length > 0 && <div><h4 className="mb-1 text-xs font-semibold text-muted-foreground">{t('architecture.connections')}</h4><div className="space-y-1">{connections.map((edge, index) => {
      const outgoing = edge.from === node.id;
      const other = scope.nodes.find(item => item.id === (outgoing ? edge.to : edge.from));
      if (!other) return null;
      return <button type="button" key={`${edge.from}:${edge.to}:${index}`} className="flex min-h-11 w-full items-center gap-2 rounded-lg bg-surface px-3 py-2 text-left text-xs hover:bg-surface-elevated" onClick={() => onSelect(other.id)} aria-label={`${outgoing ? t('architecture.outgoing') : t('architecture.incoming')}: ${other.title} · ${edge.label}`}>
        {outgoing ? <ArrowUpRight size={15} className="shrink-0 text-primary" /> : <ArrowDownLeft size={15} className="shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1"><span className="block font-medium">{other.title}</span><span className="mt-0.5 block break-words text-muted-foreground">{outgoing ? t('architecture.outgoing') : t('architecture.incoming')} · {edge.label}</span></span><ChevronRight size={14} className="shrink-0" />
      </button>;
    })}</div></div>}
    {node.files.length > 0 && <details open={node.files.length <= 4}><summary className="min-h-11 cursor-pointer py-3 text-xs font-semibold text-muted-foreground">{t('architecture.sourceFiles')} ({node.files.length})</summary>{node.files.map(file => <button type="button" key={`${file.path}:${file.line ?? ''}`} className="block min-h-11 w-full break-all rounded-lg px-2 py-2 text-left font-mono text-xs text-primary hover:bg-surface-elevated" onClick={() => onOpenFile(file)}>{file.path}{file.line ? `:${file.line}` : ''}</button>)}</details>}
  </section>;
}
