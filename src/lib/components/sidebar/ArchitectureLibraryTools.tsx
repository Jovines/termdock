import { useEffect, useRef, useState } from 'react';
import { Download, History, Link, Upload } from 'lucide-react';
import { analysisFile, ARCHITECTURE_FILE, parseArchitecture, type ArchitectureDocument } from '../../architecture/model';
import { architectureHistory, exportOmmArchitecture, importOmmArchitecture, saveNativeArchitecture, readNativeArchitecture } from '../../architecture/native';
import { saveDownloadBlob } from '../../terminal/api';
import { savedConnection } from '../../federation/browserIntegration';
import { architectureViewerUrl } from '../../architecture/link';
import { useI18n } from '../../i18n';

export function ArchitectureLibraryTools({ root, file, document, onLoaded }: { root: string; file: string; document: ArchitectureDocument | null; onLoaded: (file: string, document: ArchitectureDocument) => void }) {
  const { locale } = useI18n(), zh = locale === 'zh';
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof architectureHistory>> | null>(null);
  const [pending, setPending] = useState<{ name: string; value: unknown; file: string; revision?: string | null } | null>(null);
  const input = useRef<HTMLInputElement>(null), task = useRef(0);
  useEffect(() => { task.current++; setPending(null); setHistory(null); setError(''); setMessage(''); setBusy(false); return () => { task.current++; }; }, [root, file]);
  async function perform(action: (current: () => boolean) => Promise<void>) {
    const version = ++task.current; setBusy(true); setError(''); setMessage('');
    try { await action(() => version === task.current); } catch (reason) { if (version === task.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (version === task.current) setBusy(false); }
  }
  const button = 'inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-xs hover:bg-surface-elevated disabled:opacity-40';
  return <details className="rounded-lg border border-border/15 px-3"><summary className="min-h-11 cursor-pointer py-3 text-xs text-muted-foreground">{zh ? '历史、导入与分享' : 'History, import and sharing'}</summary>
    <div className="flex flex-wrap gap-1">
      <button className={button} type="button" disabled={busy || !document} onClick={() => void perform(async current => { const history = await architectureHistory(root, file); if (current()) setHistory(history); })}><History size={14} />{zh ? '更新差异' : 'Changes'}</button>
      <button className={button} type="button" disabled={busy || !document} onClick={() => void perform(async () => { await saveDownloadBlob(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }), 'termdock-architecture.json'); })}><Download size={14} />JSON</button>
      <button className={button} type="button" disabled={busy || !document} onClick={() => void perform(async () => { const bundle = await exportOmmArchitecture(root, file); await saveDownloadBlob(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }), 'architecture.omm.json'); })}><Download size={14} />.omm</button>
      <button className={button} type="button" disabled={busy} onClick={() => input.current?.click()}><Upload size={14} />{zh ? '导入' : 'Import'}</button>
      <button className={button} type="button" disabled={busy || !document} onClick={() => void perform(async () => { const service = savedConnection(); const url = architectureViewerUrl(window.location.origin, { root, file, ...(service ? { peerId: service.targetPeerId, serviceName: service.serviceName } : {}) }); await navigator.clipboard.writeText(url); setMessage(zh ? '链接已复制，打开时需要登录此 Termdock 服务。' : 'Link copied. Sign in to this Termdock service to view it.'); })}><Link size={14} />{zh ? '复制查看链接' : 'Copy viewer link'}</button>
    </div>
    <input ref={input} hidden type="file" accept=".json,application/json" onChange={event => {
      const candidate = event.target.files?.[0]; event.target.value = ''; if (!candidate) return;
      void perform(async current => {
        if (candidate.size > 5_000_000) throw new Error(zh ? '文档超过 5 MB。' : 'Document exceeds 5 MB.');
        const raw = await candidate.text(); if (!current()) return; const value = JSON.parse(raw);
        if (value?.format === 'termdock-omm-bundle') { const loaded = await readNativeArchitecture(root, '.omm'); if (!current()) return; setPending({ name: candidate.name, value, file: '.omm', revision: loaded.revision }); return; }
        const document = parseArchitecture(raw), destination = document.analysis ? analysisFile(document.analysis) : ARCHITECTURE_FILE;
        const loaded = await readNativeArchitecture(root, destination);
        if (!current()) return; setPending({ name: candidate.name, value: document, file: destination, revision: loaded.revision });
      });
    }} />
    {pending && <div className="my-2 rounded-lg bg-surface-2 p-3 text-xs"><p className="break-all">{pending.name} → {pending.file}</p><p className="mt-1 text-muted-foreground">{pending.file === '.omm' ? (zh ? '合并文档中的目录和字段；同名字段将更新。' : 'Merge bundled directories and fields; matching fields are updated.') : (zh ? '保存为此范围的架构，并保留此前的版本。' : 'Save this scope and retain its previous version.')}</p><div className="mt-2 flex gap-2"><button className={`${button} text-primary`} disabled={busy} type="button" onClick={() => void perform(async current => { const document = pending.file === '.omm' ? await importOmmArchitecture(root, pending.value, pending.revision) : await saveNativeArchitecture(root, pending.file, pending.value as ArchitectureDocument, pending.revision); if (!current()) return; setPending(null); onLoaded(pending.file, document); })}>{zh ? '确认导入' : 'Import document'}</button><button className={button} disabled={busy} type="button" onClick={() => setPending(null)}>{zh ? '取消' : 'Cancel'}</button></div></div>}
    {busy && <p role="status" className="py-2 text-xs">{zh ? '处理中…' : 'Working…'}</p>}
    {error && <p role="alert" className="break-words py-2 text-xs text-destructive">{error}</p>}
    {message && <p role="status" className="py-2 text-xs text-muted-foreground">{message}</p>}
    {history && <div className="space-y-2 pb-3">{history.length === 0 && <p className="text-xs text-muted-foreground">{zh ? '还没有历史版本。使用原生命令或文档编辑保存后会保留版本。' : 'No previous versions. Native saves and document edits retain history.'}</p>}{history.map(version => <details key={version.id}><summary className="min-h-11 cursor-pointer py-3 text-xs">{new Date(version.savedAt).toLocaleString()} · {version.changes.length} {zh ? '处差异' : 'changes'}</summary><ul className="space-y-1 text-xs text-muted-foreground">{version.changes.map((change, index) => <li key={index} className="break-words">{change.kind === 'added' ? '+' : change.kind === 'removed' ? '−' : '~'} {change.title} · {change.fields.join(', ')}</li>)}</ul></details>)}</div>}
  </details>;
}
