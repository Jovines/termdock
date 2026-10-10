import type { SidebarUploadTask } from './useSidebarUpload';

export function SidebarUploadStatus({ task, labels, onCancel, onRetry, onDismiss }: {
  task: SidebarUploadTask;
  labels: { uploading: string; inserting: string; done: string; failed: string; canceled: string; referenceRejected: string; limit: string; cancel: string; retry: string; dismiss: string; files: string };
  onCancel: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const busy = task.status === 'uploading' || task.status === 'inserting';
  const message = task.error === 'reference' ? labels.referenceRejected
    : task.error === 'UPLOAD_LIMIT' ? labels.limit
    : task.status === 'error' ? `${labels.failed}: ${task.error ?? ''}` : labels[task.status];
  const canRetry = task.status === 'error' && (task.kind === 'image' && task.uploaded.length > 0 || task.retryFiles.length > 0 && task.retryFiles.length <= 50);
  return (
    <section className="shrink-0 border-t border-border/20 bg-surface/80 px-3 py-2 text-xs" data-sidebar-upload-status aria-busy={busy}>
      <div className="flex items-center gap-2">
        <span className={`min-w-0 flex-1 break-words ${task.status === 'error' ? 'text-destructive' : 'text-foreground'}`} role={task.status === 'error' ? 'alert' : 'status'}>{message}</span>
        {task.status === 'uploading' && <button type="button" className="shrink-0 rounded bg-surface-2 px-2 py-1 hover:bg-surface-elevated" onClick={onCancel}>{labels.cancel}</button>}
        {canRetry && <button type="button" className="shrink-0 rounded bg-surface-2 px-2 py-1 hover:bg-surface-elevated" onClick={onRetry}>{labels.retry}</button>}
        {!busy && <button type="button" className="shrink-0 rounded px-2 py-1 text-muted-foreground hover:bg-surface-2" onClick={onDismiss} aria-label={labels.dismiss}>×</button>}
      </div>
      <div className="mt-1 truncate text-muted-foreground" title={task.directory}>{task.directory}</div>
      <details className="mt-1 min-w-0 text-muted-foreground">
        <summary className="cursor-pointer truncate">{labels.files} · {task.files[0]?.name}</summary>
        <ul className="mt-1 max-h-24 overflow-y-auto font-mono text-[10px]">
          {task.files.map((file, index) => <li key={`${index}:${file.name}`} className="break-all">{file.name}</li>)}
          {task.uploaded.map(file => <li key={file.path} className="break-all text-foreground">{file.path}</li>)}
        </ul>
      </details>
    </section>
  );
}
