import { lazy, Suspense } from 'react';
import { ARCHITECTURE_FIELDS, type ArchitectureField, type ArchitectureFields, type ArchitectureMeta } from '../../architecture/model';
import { useI18n } from '../../i18n';

const Markdown = lazy(() => import('./RightSidebar').then(module => ({ default: module.MarkdownPreview })));
export function architectureFieldLabel(field: ArchitectureField, zh: boolean): string {
  return zh ? ({ description: '说明', diagram: '关系图源码', context: '上下文', constraint: '约束', concern: '问题与风险', todo: '待办', note: '备注' })[field] : ({ description: 'Description', diagram: 'Diagram source', context: 'Context', constraint: 'Constraints', concern: 'Concerns', todo: 'To do', note: 'Notes' })[field];
}
export function ArchitectureDocumentFields({ value, rootPath, onEdit, onOpenFile }: {
  value: ArchitectureFields & { meta?: ArchitectureMeta; title?: string }; rootPath?: string | null; onEdit?: (field: ArchitectureField) => void; onOpenFile?: (file: { path: string; line?: number }) => void;
}) {
  const { locale } = useI18n(), zh = locale === 'zh';
  const description = value.description?.replace(/^#\s+([^\n]+)\n\s*/, (heading, title: string) => title.trim() === value.title ? '' : heading);
  const markdown = (content: string) => <Suspense fallback={<p className="whitespace-pre-wrap text-sm">{content}</p>}><Markdown referenceLines={false} content={content} filePath={null} rootPath={rootPath ?? null} lineRange={null} onLineRangeClick={() => {}} scrollTop={0} outlineOpen={false} lightboxOpen={false} onLocalLinkOpen={target => onOpenFile?.({ path: rootPath && target.path.startsWith(`${rootPath}/`) ? target.path.slice(rootPath.length + 1) : target.path })} /></Suspense>;
  return <div className="space-y-2">
    {description && <div className="min-w-0 overflow-x-auto">{markdown(description)}</div>}
    {ARCHITECTURE_FIELDS.filter(field => field !== 'description' && value[field]).map(field => <details key={field} className="rounded-lg border border-border/15 px-2"><summary className="min-h-11 cursor-pointer py-3 text-xs font-medium">{architectureFieldLabel(field, zh)}</summary><div className="min-w-0 overflow-x-auto pb-2">{field === 'diagram' ? <pre className="whitespace-pre-wrap break-all text-xs">{value[field]}</pre> : markdown(value[field]!)}{onEdit && <button type="button" className="min-h-11 rounded px-2 text-xs text-primary hover:bg-surface-elevated" onClick={() => onEdit(field)}>{zh ? '编辑此字段' : 'Edit field'}</button>}</div></details>)}
    {onEdit && <button type="button" className="min-h-11 rounded-lg px-3 text-xs text-primary hover:bg-surface-elevated" onClick={() => onEdit('description')}>{zh ? '编辑文档' : 'Edit document'}</button>}
    {value.meta && <details><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">{zh ? '版本信息' : 'Version information'}</summary><dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-all pb-3 text-xs text-muted-foreground">{Object.entries(value.meta).filter(([key]) => key !== 'previousDiagram').map(([key, entry]) => <div key={key} className="contents"><dt>{({ created: zh ? '创建' : 'Created', updated: zh ? '更新' : 'Updated', updateCount: zh ? '更新次数' : 'Updates', gitCommit: 'Commit', gitBranch: zh ? '分支' : 'Branch' } as Record<string, string>)[key] ?? key}</dt><dd>{String(entry)}</dd></div>)}</dl></details>}
  </div>;
}
