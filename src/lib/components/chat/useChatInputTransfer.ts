import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { uploadFiles, uploadSessionAttachments } from '../../terminal/api';
import { prepareTerminalClipboardImage } from '../../terminal/clipboardImage';
import { readClipboardContent } from '../../terminal/clipboardContent';
import { escapeShellPath } from '../../desktop/shellPath';
import { selectedTarget } from '../../federation/clientScope';
import { currentSecureClient } from '../../federation/browserIntegration';
import { getActiveKeyboardLayer } from '../../hooks/useKeyboardLayer';
import type { ChatAttachment, ChatInsertionPoint } from './chatComposerContent';
interface Options {
  sessionId: string; active: boolean; canWrite: boolean; directory?: string; sessionAttachments?: boolean;
  input: RefObject<HTMLTextAreaElement>; insert: (text: string, focus?: boolean) => void; error: (message: string) => void;
  attach?: (files: ChatAttachment[], focus: boolean, at: ChatInsertionPoint) => void;
}
interface Transfer { stage: 'reading' | 'uploading' | 'failed' | 'cancelled'; percent?: number; files?: File[]; paths?: string[] }
export function useChatInputTransfer(options: Options) {
  const latest = useRef(options); latest.current = options;
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const work = useRef<{ controller: AbortController; current: () => boolean; focus: () => boolean; at: ChatInsertionPoint } | null>(null);
  const mounted = useRef(true);
  const begin = useCallback(() => {
    work.current?.controller.abort();
    const scope = latest.current, target = selectedTarget(), client = currentSecureClient(), layer = getActiveKeyboardLayer(), focused = document.activeElement;
    const controller = new AbortController();
    const node = scope.input.current;
    const operation = { controller, at: { value: node?.value || '', start: node?.selectionStart ?? 0, end: node?.selectionEnd ?? 0 }, current: () => mounted.current && !controller.signal.aborted && work.current === operation
      && latest.current.active && latest.current.canWrite && latest.current.sessionId === scope.sessionId
      && selectedTarget() === target && currentSecureClient() === client && !client?.closed && getActiveKeyboardLayer() === layer,
      focus: () => document.activeElement === focused || document.activeElement === scope.input.current || document.activeElement === document.body };
    work.current = operation;
    return operation;
  }, []);
  useEffect(() => {
    const cancelStale = () => { if (work.current && !work.current.current()) { work.current.controller.abort(); work.current = null; setTransfer(null); } };
    cancelStale();
    const revoke = () => { work.current?.controller.abort(); work.current = null; setTransfer(null); };
    window.addEventListener('termdock:secure-state', cancelStale); window.addEventListener('auth:unauthorized', revoke);
    document.addEventListener('focusin', cancelStale);
    return () => { window.removeEventListener('termdock:secure-state', cancelStale); window.removeEventListener('auth:unauthorized', revoke); document.removeEventListener('focusin', cancelStale); };
  }, [options.active, options.canWrite, options.sessionId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; work.current?.controller.abort(); }; }, []);
  const performUpload = useCallback(async (operation: NonNullable<typeof work.current>, files: File[], paths: string[] = []) => {
    if (!operation.current()) return;
    setTransfer({ stage: 'uploading', percent: files.length ? 0 : undefined, files, paths }); latest.current.error('');
    try {
      if (files.length && !latest.current.directory && !latest.current.sessionAttachments) throw new Error('附件上传暂不可用，请重试');
      const progress = (percent: number) => { if (operation.current()) setTransfer({ stage: 'uploading', percent: Math.round(percent), files, paths }); };
      const result = !files.length ? { files: [] } : latest.current.sessionAttachments
        ? await uploadSessionAttachments(latest.current.sessionId, files, operation.controller.signal, progress, operation.current)
        : await uploadFiles(latest.current.directory!, files, operation.controller.signal, progress, operation.current);
      if (!operation.current()) return;
      if (result.files.length !== files.length || result.files.some(file => !file.path)) throw new Error('部分文件未上传成功，请重试');
      const references = [...paths, ...result.files.map(file => file.path)];
      if (!references.length) throw new Error('没有可添加的文件');
      if (latest.current.attach) latest.current.attach([
        ...paths.map(path => ({ path, name: path.split('/').pop() || path })),
        ...result.files.map((file, index) => ({ path: file.path, name: files[index].name, type: files[index].type, size: files[index].size })),
      ], operation.focus(), operation.at);
      else latest.current.insert(`${references.map(escapeShellPath).join(' ')} `, operation.focus());
      setTransfer(null); work.current = null;
    } catch (error) {
      if (!operation.current()) return;
      setTransfer({ stage: 'failed', files, paths }); latest.current.error(error instanceof Error ? error.message : '文件上传失败，请重试');
    }
  }, []);
  const addFiles = useCallback((files: File[]) => {
    if (!latest.current.active || !latest.current.canWrite || !files.length) return;
    void performUpload(begin(), files);
  }, [begin, performUpload]);
  const paste = useCallback(async (eventData?: { files: File[]; text: string }) => {
    if (!latest.current.active || !latest.current.canWrite) return;
    const operation = begin(); setTransfer({ stage: 'reading' }); latest.current.error('');
    const insert = (text: string) => { if (operation.current()) { latest.current.insert(text, operation.focus()); setTransfer(null); work.current = null; } };
    try {
      const content = await readClipboardContent(eventData, operation.current);
      if (content.kind === 'text') { insert(content.text); return; }
      if (content.kind === 'files') {
        const files = content.files.length === 1 && content.files[0].type.startsWith('image/')
          ? [prepareTerminalClipboardImage(content.files[0])] : content.files;
        return await performUpload(operation, files, content.paths);
      }
      throw new Error('剪贴板没有可读取的内容，请使用系统粘贴或选择文件');
    } catch (error) {
      if (operation.current()) { setTransfer(null); latest.current.error(error instanceof Error ? error.message : '粘贴失败，请重试'); }
    }
  }, [begin, performUpload]);
  const cancel = () => { work.current?.controller.abort(); work.current = null; setTransfer(previous => previous ? { ...previous, stage: 'cancelled' } : null); };
  const retry = () => { if (transfer?.files?.length || transfer?.paths?.length) void performUpload(begin(), transfer.files || [], transfer.paths); };
  return { transfer, addFiles, paste, cancel, retry, dismiss: () => setTransfer(null), busy: transfer?.stage === 'reading' || transfer?.stage === 'uploading' };
}
