import { useEffect, useRef, useState } from 'react';
import { Archive, RefreshCw } from 'lucide-react';
import { listExecutionArchives, restoreExecutionSession, type ExecutionArchive, type OrchestrationSession } from '../../terminal/api';

export function CollaborationExecutionArchives({ groupId, version, onRestore }: {
  groupId: string; version: number; onRestore: (session: OrchestrationSession) => Promise<void>;
}) {
  const [entries, setEntries] = useState<ExecutionArchive[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pending = useRef(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try { const result = await listExecutionArchives(); if (alive) setEntries(result.entries.filter(entry => entry.groups.some(group => group.id === groupId))); }
      catch { /* Navigation retains its last successful snapshot while reconnecting. */ }
    };
    void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [groupId, version]);
  const restore = async (entry: ExecutionArchive) => {
    if (pending.current) return;
    pending.current = true; setBusy(entry.sessionId); setError('');
    try { const result = await restoreExecutionSession(entry.sessionId); await onRestore(result.session); setEntries(list => list.filter(item => item.sessionId !== entry.sessionId)); }
    catch (e) { setError(e instanceof Error ? e.message : '恢复失败，归档已保留'); }
    finally { pending.current = false; setBusy(null); }
  };
  if (!entries.length && !error) return null;
  return <details className="border-t border-border/15 text-muted-foreground">
    <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-2 text-[11px]"><Archive size={13} />已归档的执行会话 · {entries.length}</summary>
    {error && <p role="alert" className="px-2 pb-2 text-xs text-destructive">{error}</p>}
    {entries.map(entry => <div key={entry.sessionId} className="border-t border-border/10 px-2 py-2">
      <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs text-foreground">{entry.title}</span><button type="button" disabled={busy !== null} onClick={() => void restore(entry)} className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-primary hover:bg-primary/10 disabled:opacity-40">{busy === entry.sessionId && <RefreshCw size={12} className="animate-spin" />}{busy === entry.sessionId ? '恢复中…' : '恢复'}</button></div>
      <p className="text-[10px] leading-4">{entry.cleanup.state === 'removed' ? '执行目录已回收，恢复时重建；分支和结果保留。' : entry.cleanup.reason || '目录保留，可继续恢复原会话。'}</p>
      <details><summary className="min-h-11 cursor-pointer py-3 text-[10px]">{entry.agent.slug} 会话 ID 与目录</summary><code className="block select-text break-all text-[10px]">{entry.agent.sessionId}</code><span className="mt-1 block select-text break-all text-[10px]">{entry.cwd}</span></details>
    </div>)}
  </details>;
}
