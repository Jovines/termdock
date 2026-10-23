import { confirmPageAction } from '../desktop/pageFeedback';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Folder, Monitor, Pencil, Smartphone, Upload, X } from 'lucide-react';
import type { ShareResources, SharedDirectory } from '../../server/shared/shareResources';
import { ShareAccessContext } from './ShareAccessContext';
import { FileTree } from '../components/sidebar/FileTree';
import { Sidebar } from '../components/sidebar/Sidebar';
import { readFileContent, uploadFiles, uploadSessionAttachments } from '../terminal/api';
import type { AndroidRecording } from '../android/api';
import { RecordingSaveDialog } from '../components/android/RecordingSaveDialog';
import { captureReferenceInsertionScope } from '../components/sidebar/requestReferenceInsertion';
import { buildReferenceInputText } from '../components/sidebar/referencePaths';
import { useSidebarStore } from '../stores/useSidebarStore';
const Android = lazy(() => import('../components/android/AndroidMirrorView').then(m => ({ default: m.AndroidMirrorView })));
const Computer = lazy(() => import('../components/computer/ComputerControlView'));
const Preview = lazy(() => import('../components/sidebar/RightSidebar').then(m => ({ default: m.FilePreview })));
const action = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-xs hover:bg-surface-2 disabled:opacity-40';
function SharedPhone({ sessionId, canWrite, onInsert }: { sessionId?: string; canWrite: boolean; onInsert: (text: string, source?: HTMLElement) => unknown | Promise<unknown> }) {
  const [recording, setRecording] = useState<AndroidRecording>();
  const live = useRef(true), target = useRef({ sessionId, canWrite, onInsert }); target.current = { sessionId, canWrite, onInsert };
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const insertFile = async (file: File, source?: HTMLElement) => {
    const inScope = captureReferenceInsertionScope(source), id = sessionId;
    const current = () => live.current && inScope() && target.current.sessionId === id && target.current.canWrite;
    if (!id || !current()) throw new Error('此会话当前无法添加附件');
    const result = await uploadSessionAttachments(id, [file], undefined, undefined, current);
    const path = result.files[0]?.path;
    if (!path || !current() || await target.current.onInsert(buildReferenceInputText(path, null), source) === false) throw new Error('截图尚未添加，请重试');
  };
  return <><Android sessionId={sessionId} onInsertFile={canWrite && sessionId ? insertFile : undefined} onInsertPrompt={canWrite ? async (text, source) => { if (await onInsert(text, source) === false) throw new Error('当前无法添加'); } : undefined} onRecordingComplete={canWrite && sessionId ? file => { if (live.current) setRecording(file); } : undefined} />
    {recording && <RecordingSaveDialog key={recording.id} file={recording} initialPath="/" onInsert={async (text, source) => target.current.canWrite && live.current ? target.current.onInsert(buildReferenceInputText(text, null), source) : false} onDone={() => setRecording(undefined)} />}</>;
}
function SharedFiles({ directories, onInsert, onDirty }: { directories: SharedDirectory[]; onInsert: (text: string) => void; onDirty: (dirty: boolean) => void }) {
  const [root, setRoot] = useState(directories[0]?.path || '');
  const [file, setFile] = useState<string | null>(null);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [editing, setEditing] = useState<{ path: string; original: string; content: string }>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [version, setVersion] = useState(0);
  const [discard, setDiscard] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => { if (!directories.some(d => d.path === root)) { setRoot(directories[0]?.path || ''); setFile(null); setEditing(undefined); } }, [directories, root]);
  useEffect(() => { useSidebarStore.getState().setRootPath(root); }, [root]);
  const writable = directories.some(d => d.access === 'write' && (file ? file === d.path || file.startsWith(d.path.replace(/\/+$/, '') + '/') : root === d.path));
  const save = async () => {
    if (!editing) return; setBusy(true); setError('');
    try {
      const response = await fetch(`/api/terminal/fs/write?${new URLSearchParams({ path: editing.path })}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: editing.content, original: editing.original }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error);
      if (live.current) { setEditing(undefined); setVersion(v => v + 1); }
    } catch (failure) { if (live.current) setError(failure instanceof Error ? failure.message : '保存失败，编辑内容已保留'); }
    finally { if (live.current) setBusy(false); }
  };
  useEffect(() => { const dirty = !!editing && editing.content !== editing.original; onDirty(dirty); const unload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', unload); return () => { window.removeEventListener('beforeunload', unload); onDirty(false); }; }, [editing, onDirty]);
  const leaveEditor = () => { if (editing && editing.content !== editing.original) setDiscard(true); else setEditing(undefined); };
  return <div className="flex min-h-0 flex-1 flex-col"><div className="flex shrink-0 items-center gap-1 border-b border-border/30 p-2">
    {file ? <><button type="button" className={action} disabled={!!editing || busy} onClick={() => { setFile(null); setError(''); }}><ArrowLeft size={14} />文件列表</button><span className="min-w-0 flex-1 truncate text-xs" title={file}>{file.split('/').pop()}</span>{writable && !editing && <button type="button" className={action} disabled={busy} onClick={() => { setBusy(true); setError(''); void readFileContent(file).then(value => { if (value.binary || value.truncated || value.size > 1024 * 1024) throw new Error('仅支持编辑 1 MB 以内的完整文本'); if (live.current) setEditing({ path: file, content: value.content, original: value.content }); }).catch(e => setError(e.message)).finally(() => setBusy(false)); }}><Pencil size={14} />编辑</button>}</> : <><select aria-label="共享目录" className="min-h-11 min-w-0 flex-1 rounded-lg bg-surface px-2 text-xs" value={root} onChange={e => { setRoot(e.target.value); setError(''); }}>{directories.map((d, i) => <option key={i} value={d.path}>{d.path} · {d.access === 'write' ? '可修改' : '只读'}</option>)}</select>{writable && <button type="button" className={action} disabled={busy} onClick={() => upload.current?.click()}><Upload size={14} />上传</button>}<input ref={upload} type="file" multiple hidden onChange={e => { const files = Array.from(e.target.files || []); e.target.value = ''; if (!files.length) return; const target = root; setBusy(true); setError(''); void uploadFiles(target, files).then(() => { useSidebarStore.getState().invalidateDirectoryCache(target); setVersion(v => v + 1); }).catch(e => setError(e.message)).finally(() => setBusy(false)); }} /></>}
  </div>{error && <p role="alert" className="p-3 text-xs leading-5 text-destructive">{error}</p>}
  {editing ? <div className="flex min-h-0 flex-1 flex-col"><textarea aria-label="编辑文件内容" spellCheck={false} className="min-h-0 flex-1 resize-none bg-background p-3 font-mono text-sm leading-6 outline-none" value={editing.content} disabled={busy} onChange={e => setEditing({ ...editing, content: e.target.value })} /><div className="shrink-0 border-t border-border p-2">{discard ? <div className="space-y-2"><p className="text-xs">有未保存的修改，确定放弃？</p><button type="button" className={action} onClick={() => setDiscard(false)}>继续编辑</button><button type="button" className={`${action} text-destructive`} onClick={() => { setEditing(undefined); setDiscard(false); }}>放弃修改</button></div> : <div className="flex justify-end gap-2"><button type="button" className={action} disabled={busy} onClick={leaveEditor}>取消编辑</button><button type="button" className={`${action} bg-primary text-primary-foreground`} disabled={busy} onClick={() => void save()}>{busy ? '正在保存…' : '保存修改'}</button></div>}</div></div> : file ? <div className="min-h-0 flex-1 overflow-auto"><Suspense fallback={<p className="p-4 text-sm text-muted-foreground">正在读取预览…</p>}><Preview key={`${file}:${version}`} filePath={file} onInsertReference={path => onInsert(path)} onInsertText={onInsert} onReferenceCopied={() => {}} isMobile markdownOutlineOpen={false} markdownImageLightboxOpen={false} lineRange={range} onLineRangeChange={setRange} insertedReferenceKey={null} copiedReferenceKey={null} /></Suspense></div> : <div className="min-h-0 flex-1 overflow-auto"><FileTree key={`${root}:${version}`} rootPath={root} selectedFilePath={file} onFileSelect={setFile} onPathReference={onInsert} /></div>}
  </div>;
}
export function SessionResourceSidebar({ resources, sessionId, canWrite = false, pinned, open, onClose, onInsert }: { resources: ShareResources; sessionId?: string; canWrite?: boolean; pinned: boolean; open: boolean; onClose: () => void; onInsert: (text: string, source?: HTMLElement) => unknown | Promise<unknown> }) {
  const tabs = [resources.android?.length ? 'android' : '', resources.computers?.length ? 'computer' : '', resources.directories?.length ? 'files' : ''].filter(Boolean);
  const [tab, setTab] = useState(tabs[0]);
  const effectiveTab = tabs.includes(tab) ? tab : tabs[0];
  const dirty = useRef(false);
  const setDirty = useRef((value: boolean) => { dirty.current = value; }).current;
  const changeTab = async (value: string) => { if (value === tab) return; if (dirty.current && !await confirmPageAction({ title: '放弃文件修改？', message: '当前文件有未保存的修改。', confirmLabel: '放弃修改', cancelLabel: '继续编辑' })) return; setTab(value); };
  const [computer, setComputer] = useState(0);
  const chosen = resources.computers?.[computer] ?? resources.computers?.[0];
  const context = effectiveTab === 'computer' ? { ...resources, computers: chosen ? [chosen] : [] } : resources;
  if (!tabs.length) return null;
  return <ShareAccessContext.Provider value={context}><Sidebar side="right" isOpen={open} pinned={pinned} drawerWidthPx={Math.min(window.innerWidth - 16, 480)} onClose={onClose}><div className="flex min-h-0 flex-1 flex-col"><header className="flex shrink-0 items-center gap-1 border-b border-border/40 px-2 py-1"><div role={tabs.length > 1 ? 'tablist' : undefined} aria-label="侧栏功能" className="flex min-w-0 flex-1 gap-1">{tabs.map(value => { const [label, Icon] = value === 'android' ? ['手机', Smartphone] as const : value === 'computer' ? ['电脑', Monitor] as const : ['文件', Folder] as const; return tabs.length === 1 ? <span key={value} className="inline-flex min-h-9 items-center gap-2 px-2 text-xs"><Icon size={14} />{label}</span> : <button type="button" role="tab" aria-selected={effectiveTab === value} key={value} onClick={() => void changeTab(value)} className={`${action} flex-1 ${effectiveTab === value ? 'bg-surface-elevated' : 'text-muted-foreground'}`}><Icon size={14} />{label}</button>; })}</div><button type="button" className={action} aria-label="关闭共享侧栏" onClick={onClose}><X size={17} /></button></header><Suspense fallback={<p role="status" className="p-4 text-sm text-muted-foreground">正在打开共享内容…</p>}>{effectiveTab === 'android' && open && <SharedPhone key={sessionId} sessionId={sessionId} canWrite={canWrite} onInsert={onInsert} />}{effectiveTab === 'computer' && <>{(resources.computers?.length ?? 0) > 1 && <select aria-label="共享电脑" className="min-h-11 bg-surface px-3 text-xs" value={computer} onChange={e => setComputer(Number(e.target.value))}>{resources.computers?.map((c, i) => <option key={i} value={i}>{c.host}:{c.port}</option>)}</select>}<Computer key={JSON.stringify(chosen)} active={open} /></>}{effectiveTab === 'files' && <SharedFiles directories={resources.directories!} onInsert={onInsert} onDirty={setDirty} />}</Suspense></div></Sidebar></ShareAccessContext.Provider>;
}
