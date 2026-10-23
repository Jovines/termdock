import './openuiRuntime';
import { createContext, lazy, Suspense, useContext, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createLibrary, createParser, FormNameContext, Renderer, useFormName, useStateField, useTriggerAction, type ActionEvent, type ComponentRenderProps } from '@openuidev/react-lang';
import { ArrowDownUp, Check, Circle, ExternalLink, FileText, Search, X } from 'lucide-react';
import { chatUILibrary, chatUISchemas } from '../../../server/shared/chatUILibrary';
import { requestReferenceInsertion } from '../sidebar/requestReferenceInsertion';
import { buildReferenceInputText } from '../sidebar/referencePaths';
import { useKeyboardLayer } from '../../hooks/useKeyboardLayer';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { ChatMarkdown } from './ChatMarkdown';
import { useChatUIState } from './useChatUIState';
import { chatUIActionText } from './chatUIActions';
import type { ChatMessage } from './chatMessages';
const field = 'min-h-11 w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2 text-base outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 sm:text-sm';
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border px-4 py-2 text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40';
// Metrics share a compact row; prose, tables and sections keep the full width.
// Apply this to rendered blocks so saved OpenUI replies benefit as well.
const contentLayout = 'grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-x-6 gap-y-4 [&>*:not([data-chat-metric])]:col-span-full';
const Preview = lazy(() => import('../sidebar/RightSidebar').then(module => ({ default: module.FilePreview })));
const context = createContext({ canWrite: false, resource: (_path: string) => {} });
function RichTable({ columns, rows, caption }: { columns: string[]; rows: (string | number | boolean | null)[][]; caption?: string }) {
  const [query, setQuery] = useState(''), [sort, setSort] = useState<{ column: number; direction: number }>();
  const visible = useMemo(() => {
    const filtered = rows.filter(row => !query || row.some(value => String(value ?? '').toLocaleLowerCase().includes(query.toLocaleLowerCase())));
    return sort ? filtered.slice().sort((a, b) => sort.direction * (typeof a[sort.column] === 'number' && typeof b[sort.column] === 'number' ? Number(a[sort.column]) - Number(b[sort.column]) : String(a[sort.column] ?? '').localeCompare(String(b[sort.column] ?? ''), undefined, { numeric: true }))) : filtered;
  }, [rows, query, sort]);
  return <div className="min-w-0 space-y-2">{caption && <p className="text-sm font-medium">{caption}</p>}{rows.length > 5 && <label className="flex max-w-sm items-center gap-2 rounded-xl border border-border px-3 text-muted-foreground"><Search size={15} /><input aria-label="筛选表格" className="min-h-11 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none" value={query} onChange={event => setQuery(event.target.value)} placeholder="筛选内容…" /></label>}<div role="region" aria-label="交互表格，可横向滚动" tabIndex={0} className="max-w-full overflow-x-auto rounded-xl border border-border [touch-action:pan-x_pan-y]"><table className="w-full text-left text-sm"><thead className="bg-surface">{<tr>{columns.map((column, index) => <th key={index} aria-sort={sort?.column === index ? sort.direction === 1 ? 'ascending' : 'descending' : 'none'} className="whitespace-nowrap border-b border-border px-3 py-1 font-medium"><button type="button" className="group inline-flex min-h-11 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9" onClick={() => setSort({ column: index, direction: sort?.column === index ? -sort.direction : 1 })}>{column}<ArrowDownUp size={12} className={sort?.column === index ? 'text-primary' : 'text-muted-foreground opacity-50 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-visible:opacity-100'} /></button></th>)}</tr>}</thead><tbody>{visible.map((row, index) => <tr key={index} className="border-b border-border/40 last:border-0">{columns.map((_, cell) => <td key={cell} className="min-w-40 max-w-sm whitespace-pre-wrap break-words px-3 py-3 align-top leading-6 sm:py-2.5">{String(row[cell] ?? '')}</td>)}</tr>)}</tbody></table>{!visible.length && <p className="p-4 text-sm text-muted-foreground">没有匹配的内容</p>}</div></div>;
}
function RichChart({ title, labels, series, kind = 'bar' }: { title: string; labels: string[]; series: { name: string; values: number[] }[]; kind?: 'bar' | 'line' }) {
  const [hidden, setHidden] = useState<string[]>([]);
  const shown = series.filter(item => !hidden.includes(item.name)), numbers = shown.flatMap(item => item.values);
  const min = Math.min(0, ...numbers), max = Math.max(1, ...numbers), span = max - min || 1;
  const y = (value: number) => {
    if (Number.isFinite(span)) return 190 - (value - min) / span * 164;
    const scale = Math.max(Math.abs(min), Math.abs(max));
    return 190 - (value / scale - min / scale) / (max / scale - min / scale) * 164;
  };
  const colors = ['var(--primary)', 'var(--accent)', 'var(--warning)', 'var(--tmux)', 'var(--destructive)', 'var(--foreground)'];
  const width = Math.max(440, labels.length * 55), slot = (width - 60) / labels.length;
  return <figure className="min-w-0 space-y-3"><figcaption className="text-sm font-medium">{title}</figcaption><div className="flex flex-wrap gap-2">{series.map((item, index) => <button type="button" key={index} aria-pressed={!hidden.includes(item.name)} className={`${button} min-h-9 px-2 text-xs ${hidden.includes(item.name) ? 'opacity-40' : ''}`} onClick={() => setHidden(current => current.includes(item.name) ? current.filter(name => name !== item.name) : [...current, item.name])}><span className="h-2 w-2 rounded-full" style={{ backgroundColor: colors[index % colors.length] }} />{item.name}</button>)}</div><div role="region" aria-label={`${title}，可横向滚动`} tabIndex={0} className="max-w-full overflow-x-auto"><svg role="img" aria-label={title} viewBox={`0 0 ${width} 230`} className="h-60 min-w-full" style={{ minWidth: width }}><line x1="40" x2={width - 8} y1={y(0)} y2={y(0)} stroke="var(--border)" /><text x="4" y="22" fill="var(--muted-foreground)" fontSize="11">{max.toLocaleString()}</text>{shown.map(item => { const index = series.indexOf(item), color = colors[index % colors.length]; return kind === 'line' ? <g key={index}><polyline fill="none" stroke={color} strokeWidth="2.5" points={item.values.slice(0, labels.length).map((value, at) => `${40 + slot * (at + .5)},${y(value)}`).join(' ')} />{item.values.slice(0, labels.length).map((value, at) => <circle key={at} cx={40 + slot * (at + .5)} cy={y(value)} r="4" fill={color}><title>{labels[at]} · {item.name}: {value}</title></circle>)}</g> : <g key={index}>{item.values.slice(0, labels.length).map((value, at) => <rect key={at} x={40 + slot * at + slot * .15 + slot * .7 / Math.max(1, shown.length) * shown.indexOf(item)} y={Math.min(y(0), y(value))} width={slot * .7 / Math.max(1, shown.length) - 2} height={Math.max(1, Math.abs(y(value) - y(0)))} rx="3" fill={color}><title>{labels[at]} · {item.name}: {value}</title></rect>)}</g>; })}{labels.map((label, index) => <text key={index} x={40 + slot * (index + .5)} y="216" textAnchor="middle" fill="var(--muted-foreground)" fontSize="11">{label.length > 9 ? label.slice(0, 8) + '…' : label}<title>{label}</title></text>)}</svg></div><details className="text-xs text-muted-foreground"><summary className="cursor-pointer py-2">查看数据</summary><RichTable columns={['项目', ...series.map(item => item.name)]} rows={labels.map((label, index) => [label, ...series.map(item => item.values[index] ?? null)])} /></details></figure>;
}
function RichField({ type, props }: { type: 'Input' | 'Select' | 'Checkbox'; props: Record<string, unknown> }) {
  const { canWrite } = useContext(context), name = String(props.name), label = String(props.label);
  const state = useStateField<unknown>(name, type === 'Checkbox' ? false : '');
  if (type === 'Checkbox') return <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" className="h-4 w-4 accent-primary" disabled={!canWrite} checked={state.value === true} onChange={event => state.setValue(event.target.checked)} />{label}</label>;
  return <label className="block space-y-2 text-sm"><span>{label}{props.required ? <span className="ml-1 text-muted-foreground">*</span> : null}</span>{type === 'Select' ? <select className={field} disabled={!canWrite} required={props.required === true} value={typeof state.value === 'string' ? state.value : ''} onChange={event => state.setValue(event.target.value)}><option value="">请选择</option>{(props.options as string[]).map(option => <option key={option}>{option}</option>)}</select> : <input className={field} type="text" disabled={!canWrite} required={props.required === true} maxLength={8000} value={typeof state.value === 'string' ? state.value : ''} placeholder={String(props.placeholder || '')} onChange={event => state.setValue(event.target.value)} />}</label>;
}
function RichButton({ props }: { props: Record<string, unknown> }) {
  const { canWrite } = useContext(context), trigger = useTriggerAction(), form = useFormName();
  return <button type="button" data-ui-submit className={`${button} bg-primary text-primary-foreground hover:opacity-90`} disabled={!canWrite} onClick={event => { if (event.currentTarget.form && !event.currentTarget.form.reportValidity()) return; void trigger(String(props.label), form, props.action as Parameters<typeof trigger>[2]); }}>{String(props.label)}</button>;
}
function RichResource({ props }: { props: Record<string, unknown> }) {
  const { resource } = useContext(context);
  const target = String(props.target), label = String(props.label);
  let url: URL | undefined; try { const parsed = new URL(target); if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed; } catch { /* Files are absolute paths. */ }
  const body = <><span className="text-primary">{props.kind === 'file' ? <FileText size={18} /> : <ExternalLink size={18} />}</span><span className="min-w-0 flex-1 text-left"><span className="block break-words font-medium">{label}</span>{!!props.description && <span className="mt-1 block break-words text-xs text-muted-foreground">{String(props.description)}</span>}</span></>;
  const style = `${button} w-full justify-start py-3`;
  if (props.kind === 'link' && url) return <a className={style} href={url.href} target="_blank" rel="noopener noreferrer">{body}</a>;
  return <button type="button" className={style} disabled={props.kind !== 'file' || !/^(?:\/|[a-zA-Z]:[\\/])/.test(target)} onClick={() => resource(target)}>{body}</button>;
}
function Block({ name, props, renderNode }: ComponentRenderProps & { name: string }) {
  // OpenUI resolves action expressions into runtime plans before rendering.
  if (name === 'Button') chatUISchemas.Button.omit({ action: true }).parse(props);
  else if (name in chatUISchemas) (chatUISchemas[name as keyof typeof chatUISchemas]).parse(props);
  if (name === 'Text') return <ChatMarkdown content={String(props.content)} />;
  if (name === 'Metric') return <dl data-chat-metric className="min-w-0 space-y-1 py-1"><dt className="text-xs text-muted-foreground">{String(props.label)}</dt><dd className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"><span className="break-words text-xl font-semibold leading-7 tabular-nums">{String(props.value)}</span>{!!props.detail && <span className="text-xs leading-5 text-muted-foreground">{String(props.detail)}</span>}</dd></dl>;
  if (name === 'Callout') return <aside className={`min-w-0 rounded-r-lg border-l-2 bg-surface px-3 py-2.5 ${props.tone === 'warning' ? 'border-warning' : props.tone === 'success' ? 'border-primary' : 'border-accent'}`}><p className="mb-1 text-xs font-medium">{String(props.title)}</p><ChatMarkdown content={String(props.content)} /></aside>;
  if (name === 'Table') return <RichTable {...chatUISchemas.Table.parse(props)} />;
  if (name === 'Chart') return <RichChart {...chatUISchemas.Chart.parse(props)} />;
  if (name === 'Checklist') { const value = chatUISchemas.Checklist.parse(props); return <section className="space-y-3"><h4 className="text-sm font-medium">{value.title}</h4><ul className="space-y-3">{value.items.map((item, index) => <li key={index} className="flex gap-3">{item.done ? <Check size={17} className="mt-0.5 shrink-0 text-primary" /> : <Circle size={17} className="mt-0.5 shrink-0 text-muted-foreground" />}<div className="min-w-0"><p className="text-sm">{item.label}</p>{item.detail && <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.detail}</p>}</div></li>)}</ul></section>; }
  if (name === 'Input' || name === 'Select' || name === 'Checkbox') return <RichField type={name} props={props} />;
  if (name === 'Button') return <RichButton props={props} />;
  if (name === 'Resource') return <RichResource props={props} />;
  if (name === 'Form') return <FormNameContext.Provider value={String(props.name)}><form className="w-full max-w-2xl space-y-4 rounded-xl border border-border bg-surface p-4" onSubmit={event => { event.preventDefault(); event.currentTarget.querySelector<HTMLButtonElement>('[data-ui-submit]')?.click(); }}><h4 className="text-sm font-medium">{String(props.title)}</h4>{renderNode(props.fields)}</form></FormNameContext.Provider>;
  if (name === 'Card') return <section className="min-w-0 space-y-3"><h3 className="text-base font-semibold leading-6">{String(props.title)}</h3><div className={contentLayout}>{renderNode(props.content)}</div></section>;
  return <div className={`${contentLayout} gap-y-6`}>{renderNode(props.content)}</div>;
}
const library = createLibrary({ id: chatUILibrary.id, root: chatUILibrary.root, components: Object.values(chatUILibrary.components).map(component => ({ ...component, component: (props: ComponentRenderProps) => <Block {...props} name={component.name} /> })) });
const parser = createParser(chatUILibrary.toJSONSchema());
function FileDialog({ path, close, sessionId, canWrite }: { path: string; close: () => void; sessionId: string; canWrite: boolean }) {
  const panel = useRef<HTMLDivElement>(null), [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [error, setError] = useState(''), [copied, setCopied] = useState<string | null>(null);
  useKeyboardLayer(panel, true, close);
  const insert = async (text: string, source?: HTMLElement) => {
    if (!canWrite) { setError('此会话仅允许查看'); return; }
    const accepted = await requestReferenceInsertion(text, sessionId, () => panel.current?.isConnected === true, source);
    if (accepted) close(); else setError('暂时无法添加到输入框，请稍后重试。');
  };
  return createPortal(<div data-sidebar-gesture-ignore className="fixed inset-0 z-modal-backdrop flex items-center justify-center bg-[var(--app-backdrop)] p-2 sm:p-6" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="文件预览" className="z-modal-panel flex h-[90dvh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-surface text-foreground"><header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-4"><span className="min-w-0 flex-1 truncate text-sm" title={path}>{path.split(/[\\/]/).pop()}</span><button type="button" aria-label="关闭文件预览" className={button} onClick={close}><X size={17} /></button></header><div className="min-h-0 flex-1 overflow-auto">{error && <p role="alert" className="px-4 py-2 text-xs text-destructive">{error}</p>}<Suspense fallback={<p className="p-4 text-sm text-muted-foreground">正在读取文件…</p>}><Preview filePath={path} onInsertReference={(path, _key, source) => { void insert(buildReferenceInputText(path, null), source); }} onInsertText={(text, _key, source) => { void insert(text, source); }} onReferenceCopied={setCopied} isMobile={window.innerWidth < 640} markdownOutlineOpen={false} markdownImageLightboxOpen={false} lineRange={range} onLineRangeChange={setRange} insertedReferenceKey={null} copiedReferenceKey={copied} /></Suspense></div></div></div>, document.body);
}
export function ChatRichContent({ message, sessionId, canWrite, onAction }: { message: ChatMessage; sessionId: string; canWrite: boolean; onAction: (content: string) => Promise<boolean> }) {
  const ui = message.ui!, [invalid, setInvalid] = useState(false), [actionError, setActionError] = useState(''), [acting, setActing] = useState(false), [file, setFile] = useState<string>();
  const parsed = useMemo(() => { try { return parser.parse(ui.code); } catch { return null; } }, [ui.code]);
  const valid = ui.version === 1 && parsed?.root && !parsed.meta.incomplete && !parsed.meta.errors.length && !parsed.meta.unresolved.length && parsed.meta.statementCount <= 256 && !parsed.queryStatements.length && !parsed.mutationStatements.length;
  const state = useChatUIState(sessionId, message.id, message.uiState, canWrite && !!valid && !invalid);
  const action = async (event: ActionEvent) => {
    if (!canWrite || acting) return;
    if (event.type === 'open_url') {
      try { const url = new URL(String(event.params.url)); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(); window.open(url.href, '_blank', 'noopener,noreferrer'); }
      catch { setActionError('链接无效，请通过消息确认地址。'); }
      return;
    }
    if (event.type !== 'continue_conversation') { setActionError('此操作暂不可用，请通过消息说明你的选择。'); return; }
    const content = chatUIActionText(event, parsed?.root || null);
    setActing(true); setActionError('');
    try { if (!await state.save()) { setActionError('请先保存填写内容，再提交。'); return; } if (!await onAction(content)) setActionError('暂时无法提交，请稍后重试。'); }
    finally { setActing(false); }
  };
  if (!valid || invalid) return <div className="space-y-2"><ChatMarkdown content={message.content} /><p className="text-xs text-muted-foreground">已显示文字说明</p></div>;
  return <ErrorBoundary fallback={<ChatMarkdown content={message.content} />}><context.Provider value={{ canWrite: canWrite && !acting, resource: setFile }}><div data-chat-rich-content className="min-w-0 space-y-3"><Renderer library={library} response={ui.code} initialState={state.hydration} onStateUpdate={state.update} onAction={event => { void action(event); }} onError={errors => { if (errors.some(error => error.severity !== 'warning')) setInvalid(true); }} toolProvider={null} publishObservability={false} />{state.error ? <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive"><span>{state.error}</span><button type="button" className={`${button} min-h-9 text-foreground`} disabled={!canWrite} onClick={state.retry}>重新保存</button></div> : state.status && <p role="status" className="text-xs text-muted-foreground">{state.status}</p>}{actionError && <p role="alert" className="text-xs text-destructive">{actionError}</p>}{acting && <p role="status" className="text-xs text-muted-foreground">正在提交…</p>}{file && <FileDialog path={file} sessionId={sessionId} canWrite={canWrite} close={() => setFile(undefined)} />}</div></context.Provider></ErrorBoundary>;
}
