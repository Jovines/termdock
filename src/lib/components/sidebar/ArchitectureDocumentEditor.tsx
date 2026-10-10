import { useEffect, useRef, useState } from 'react';
import { ARCHITECTURE_FIELDS, architectureSourceDiagram, type ArchitectureDocument, type ArchitectureField } from '../../architecture/model';
import { readNativeArchitecture, writeArchitectureField } from '../../architecture/native';
import { useI18n } from '../../i18n';
import { architectureFieldLabel } from './ArchitectureDocumentFields';

export function ArchitectureDocumentEditor({ root, file, perspective, node, initialField, onSaved, onCancel }: {
  root: string; file: string; perspective: string; node?: string; initialField: ArchitectureField; onSaved: (document: ArchitectureDocument) => void; onCancel: () => void;
}) {
  const { locale } = useI18n(), zh = locale === 'zh';
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof readNativeArchitecture>> | null>(null);
  const [field, setField] = useState(initialField), [text, setText] = useState(''), [original, setOriginal] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const mounted = useRef(true), epoch = useRef(0);
  useEffect(() => {
    mounted.current = true; const version = ++epoch.current; setLoaded(null); setError(''); const controller = new AbortController();
    void readNativeArchitecture(root, file, controller.signal).then(result => { if (!controller.signal.aborted && version === epoch.current) setLoaded(result); }).catch(reason => { if (!controller.signal.aborted && version === epoch.current) setError(String(reason.message)); });
    return () => { mounted.current = false; ++epoch.current; controller.abort(); };
  }, [root, file]);
  useEffect(() => {
    const view = loaded?.document?.perspectives.find(view => view.id === perspective), target = node ? view?.nodes.find(item => item.id === node) : view;
    if (!target || !view) return;
    const value = target[field] ?? (field === 'description' ? target.summary : field === 'diagram' ? architectureSourceDiagram(view, node) : '');
    setText(value); setOriginal(value);
  }, [loaded, perspective, node, field]);
  const dirty = text !== original;
  return <form className="flex min-h-0 flex-1 flex-col gap-3" onSubmit={event => {
    event.preventDefault(); if (!loaded || busy || !dirty) return;
    const version = epoch.current; setBusy(true); setError('');
    void writeArchitectureField(root, file, perspective, node, field, text, loaded.revision).then(document => { if (mounted.current && version === epoch.current) onSaved(document); }).catch(reason => { if (mounted.current && version === epoch.current) setError(reason.message); }).finally(() => { if (mounted.current && version === epoch.current) setBusy(false); });
  }}>
    <label className="flex items-center gap-2 text-xs">{zh ? '字段' : 'Field'}<select aria-label={zh ? '文档字段' : 'Document field'} className="min-h-11 min-w-0 flex-1 rounded bg-surface-2 px-2" value={field} disabled={busy || dirty} onChange={event => setField(event.target.value as ArchitectureField)}>{ARCHITECTURE_FIELDS.map(field => <option key={field} value={field}>{architectureFieldLabel(field, zh)}</option>)}</select></label>
    {dirty && <p className="text-xs text-muted-foreground">{zh ? '保存当前字段后可切换字段。' : 'Save this field before switching fields.'}</p>}
    {!loaded && !error && <p role="status" className="text-xs">{zh ? '读取最新文档…' : 'Loading the latest document…'}</p>}
    <textarea aria-label={architectureFieldLabel(field, zh)} spellCheck={false} className="min-h-56 w-full flex-1 resize-y rounded-lg border border-border/30 bg-surface-2 p-3 font-mono text-sm focus-visible:ring-2 focus-visible:ring-ring" disabled={!loaded || busy} maxLength={100000} value={text} onChange={event => setText(event.target.value)} />
    {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
    <div className="sticky bottom-0 flex gap-2 bg-surface py-2"><button type="submit" className="min-h-11 rounded-lg bg-primary/15 px-4 text-sm text-primary disabled:opacity-40" disabled={!loaded || busy || !dirty}>{busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save')}</button><button type="button" className="min-h-11 rounded-lg px-4 text-sm hover:bg-surface-elevated" disabled={busy} onClick={onCancel}>{zh ? '取消' : 'Cancel'}</button></div>
  </form>;
}
