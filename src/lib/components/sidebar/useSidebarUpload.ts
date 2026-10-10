import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadFiles, UploadFilesError, type UploadFilesResponse, type UploadedFile } from '../../terminal/api';

export interface SidebarUploadTask {
  kind: 'files' | 'image';
  directory: string;
  files: File[];
  status: 'uploading' | 'inserting' | 'done' | 'error' | 'canceled';
  uploaded: UploadedFile[];
  retryFiles: File[];
  error?: string;
}

interface Operation {
  task: SidebarUploadTask;
  controller: AbortController;
  insert?: (path: string) => Promise<boolean>;
  isCurrent?: () => boolean;
}

/** One active operation: drag/drop cannot race picker and clear its busy state. */
export function useSidebarUpload(onUploaded: (directory: string) => void) {
  const [task, setTask] = useState<SidebarUploadTask | null>(null);
  const operationRef = useRef<Operation | null>(null);
  const retainedRef = useRef<Operation | null>(null);
  const mounted = useRef(true);
  const refreshRef = useRef(onUploaded);
  refreshRef.current = onUploaded;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operationRef.current?.controller.abort(); };
  }, []);

  const run = useCallback(async (operation: Operation): Promise<boolean> => {
    if (operationRef.current) return false;
    operationRef.current = operation;
    retainedRef.current = operation;
    const update = (patch: Partial<SidebarUploadTask>) => {
      operation.task = { ...operation.task, ...patch };
      if (mounted.current && operationRef.current === operation) setTask(operation.task);
    };
    update({ status: operation.task.retryFiles.length ? 'uploading' : 'inserting', error: undefined });
    try {
      if (operation.task.retryFiles.length) {
        const result: UploadFilesResponse = await uploadFiles(operation.task.directory, operation.task.retryFiles, operation.controller.signal);
        update({ uploaded: [...operation.task.uploaded, ...result.files] });
        refreshRef.current(operation.task.directory);
        // A legacy/partial response must not quietly drop selected items.
        if (result.files.length !== operation.task.retryFiles.length) {
          const succeeded = new Set(result.results?.filter(item => item.status === 'uploaded').map(item => item.index) ?? []);
          update({ retryFiles: result.results ? operation.task.retryFiles.filter((_, index) => !succeeded.has(index)) : [] });
          throw new Error('Incomplete upload result. Check the saved paths before retrying.');
        }
        update({ retryFiles: [] });
      }
      if (operation.controller.signal.aborted) throw new DOMException('Upload canceled', 'AbortError');
      if (operation.insert) {
        update({ status: 'inserting' });
        const path = operation.task.uploaded[0]?.path;
        if (!path || !operation.isCurrent?.() || !await operation.insert(path)
          || !operation.isCurrent?.() || operation.controller.signal.aborted) {
          update({ status: 'error', error: 'reference' });
          return false;
        }
      }
      update({ status: 'done' });
      return true;
    } catch (error) {
      if (error instanceof UploadFilesError && error.result?.files.length) {
        const succeeded = new Set(error.result.results?.filter(item => item.status === 'uploaded').map(item => item.index) ?? []);
        update({ uploaded: [...operation.task.uploaded, ...error.result.files], retryFiles: error.result.results ? operation.task.retryFiles.filter((_, index) => !succeeded.has(index)) : [] });
        refreshRef.current(operation.task.directory);
      }
      update({ status: operation.controller.signal.aborted ? 'canceled' : 'error', error: error instanceof UploadFilesError && error.code === 'UPLOAD_LIMIT' ? 'UPLOAD_LIMIT' : error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
    }
  }, []);

  const start = useCallback((directory: string, files: File[], insert?: Operation['insert'], isCurrent?: Operation['isCurrent']) => {
    if (!files.length) return Promise.resolve(false);
    return run({
      task: { kind: insert ? 'image' : 'files', directory, files, retryFiles: files, uploaded: [], status: 'uploading' },
      controller: new AbortController(), insert, isCurrent,
    });
  }, [run]);
  const retry = useCallback(() => {
    const retained = retainedRef.current;
    if (!retained || operationRef.current) return Promise.resolve(false);
    // A reference failure reuses its final server path; never uploads twice.
    if (!retained.insert && !retained.task.retryFiles.length) return Promise.resolve(false);
    const next = { ...retained, controller: new AbortController(), task: { ...retained.task } };
    return run(next);
  }, [run]);
  const cancel = useCallback(() => {
    const operation = operationRef.current;
    if (!operation || operation.task.status !== 'uploading') return;
    operation.controller.abort();
  }, []);
  const dismiss = useCallback(() => {
    if (operationRef.current) return;
    retainedRef.current = null;
    setTask(null);
  }, []);
  return { task, start, retry, cancel, dismiss,
    busy: task?.status === 'uploading' || task?.status === 'inserting' };
}
