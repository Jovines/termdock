import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Paperclip, RefreshCw } from 'lucide-react';
import { focusCollaborationInput, registerCollaborationInput } from '../../collaboration/inputTarget';
import { escapeShellPath } from '../../desktop/shellPath';
import { getTermdockDesktopBridge } from '../../desktop/nativeBridge';
import { selectedTarget } from '../../federation/clientScope';
import { uploadTerminalClipboardFiles, uploadTerminalClipboardImage } from '../../terminal/clipboardImage';
import { clipboardEventContent, readClipboardContent } from '../../terminal/clipboardContent';

/** The task draft owns the text; the current page owns every attachment upload. */
export function CollaborationInput({ inputKey, paneKey, label, value, onChange, active = true, disabled = false,
  required, autoFocus, placeholder, className, onUploadChange }: {
  inputKey: string; paneKey?: string; label: string; value: string; onChange: Dispatch<SetStateAction<string>>;
  active?: boolean; disabled?: boolean; required?: boolean; autoFocus?: boolean; placeholder?: string;
  className?: string; onUploadChange?: (delta: number) => void;
}) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null), picker = useRef<HTMLInputElement>(null);
  const current = useRef({ value, onChange, onUploadChange });
  current.current = { value, onChange, onUploadChange };
  const [pending, setPending] = useState(0), [error, setError] = useState('');
  const queue = useRef(Promise.resolve());
  const operations = useRef(new Set<AbortController>());
  const scope = useRef({ active, disabled, inputKey }); scope.current = { active, disabled, inputKey };
  useEffect(() => {
    const cancel = () => { for (const operation of operations.current) operation.abort(); };
    window.addEventListener('termdock:secure-state', cancel);
    window.addEventListener('auth:unauthorized', cancel);
    return () => {
      cancel();
      window.removeEventListener('termdock:secure-state', cancel);
      window.removeEventListener('auth:unauthorized', cancel);
    };
  }, [active, disabled, inputKey]);
  useEffect(() => { const field = textarea.current; if (field) field.setSelectionRange(field.value.length, field.value.length); }, [inputKey]);
  const selection = () => ({ value: current.current.value, start: textarea.current?.selectionStart ?? value.length, end: textarea.current?.selectionEnd ?? value.length });
  const insert = (text: string, at = selection()) => {
    current.current.onChange(previous => {
      // A delayed upload may append to newer text, but must never replace it.
      if (previous !== at.value) return previous + (previous && !/\s$/.test(previous) ? '\n' : '') + text;
      return previous.slice(0, at.start) + text + previous.slice(at.end);
    });
  };
  useEffect(() => {
    if (!active) return;
    const dispose = registerCollaborationInput(text => insert(text.replace(/\r\n?/g, '\n')), inputKey, Boolean(paneKey), paneKey);
    if (!paneKey) focusCollaborationInput(inputKey);
    return dispose;
  }, [active, inputKey, paneKey]);
  const targetKey = () => { const target = selectedTarget(); return `${location.origin}:${target?.targetPeerId ?? ''}:${target?.serviceOrigin ?? ''}`; };
  const run = (work: (signal: AbortSignal, isCurrent: () => boolean) => Promise<string[] | string | null>) => {
    if (!active || disabled) return;
    const controller = new AbortController(); operations.current.add(controller);
    const at = selection(), target = targetKey();
    const isCurrent = () => !controller.signal.aborted && scope.current.active && !scope.current.disabled && scope.current.inputKey === inputKey && target === targetKey();
    const changeBusy = current.current.onUploadChange;
    setError(''); setPending(n => n + 1); changeBusy?.(1);
    queue.current = queue.current.then(async () => {
      try {
        if (!isCurrent()) return;
        const result = await work(controller.signal, isCurrent);
        if (!isCurrent()) return;
        if (Array.isArray(result)) insert(result.map(escapeShellPath).join(' ') + ' ', at);
        else if (result) insert(result, at);
      } catch (e) { if (controller.signal.aborted) return; const message = target !== targetKey() ? '目标服务已切换，请重新添加附件' : e instanceof Error ? e.message : '附件准备失败，请重试';
        setError(message.includes('Upload did not return') ? '附件上传未返回完整路径，请重试' : message); }
      finally { operations.current.delete(controller); setPending(n => n - 1); changeBusy?.(-1); }
    });
  };
  const filesText = async (files: File[], signal?: AbortSignal) => files.length === 1 && files[0].type.startsWith('image/')
    ? [await uploadTerminalClipboardImage(files[0], signal)] : uploadTerminalClipboardFiles(files, signal);
  const paste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const { files, text } = clipboardEventContent(event.clipboardData);
    const native = getTermdockDesktopBridge();
    if (!native?.readClipboardFiles && !files.length && text) return;
    if (!native && !files.length && typeof navigator.clipboard?.read !== 'function') return;
    event.preventDefault();
    run(async (signal, isCurrent) => {
      const content = await readClipboardContent({ files, text }, isCurrent);
      if (content.kind === 'files') return [...content.paths, ...await filesText(content.files, signal)];
      return content.kind === 'text' ? content.text : null;
    });
  };
  return <div className="space-y-1.5" onFocusCapture={() => focusCollaborationInput(inputKey)} onPointerDownCapture={() => focusCollaborationInput(inputKey)}>
    <label htmlFor={id} className="block text-xs text-muted-foreground">{label}</label>
    <textarea ref={textarea} id={id} value={value} required={required} disabled={disabled} autoFocus={autoFocus}
      aria-describedby={pending || error ? `${id}-status` : undefined} placeholder={placeholder} className={className}
      onChange={event => onChange(event.target.value)} onPaste={paste}
      onDragOver={event => { if (!disabled && event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
      onDrop={event => {
        const files = Array.from(event.dataTransfer.files);
        if (!files.length || disabled) return;
        event.preventDefault(); event.stopPropagation();
        run(signal => filesText(files, signal));
      }} />
    <div className="flex min-h-9 items-center gap-2">
      <input ref={picker} type="file" multiple hidden aria-label={`选择附件：${label}`} onChange={event => {
        const files = Array.from(event.target.files ?? []); event.target.value = '';
        if (files.length) run(signal => filesText(files, signal));
      }} />
      <button type="button" aria-label={`添加附件：${label}`} title="添加附件" disabled={disabled}
        className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-surface-2 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        onClick={() => picker.current?.click()}><Paperclip size={14} />附件</button>
      {pending > 0 ? <span id={`${id}-status`} role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><RefreshCw size={12} className="animate-spin" />正在准备附件…</span>
        : error ? <span id={`${id}-status`} role="alert" className="break-words text-xs text-destructive">{error}</span>
          : <span className="text-[11px] text-muted-foreground/70">可粘贴图片、文件或拖入附件</span>}
    </div>
  </div>;
}
