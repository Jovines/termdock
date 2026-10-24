import { lazy, Suspense, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { requestReferenceInsertion } from '../sidebar/requestReferenceInsertion';
import { buildReferenceInputText } from '../sidebar/referencePaths';
import { useKeyboardLayer } from '../../hooks/useKeyboardLayer';

const Preview = lazy(() => import('../sidebar/RightSidebar').then(module => ({ default: module.FilePreview })));
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border px-4 py-2 text-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40';

export function ChatFilePreview({ path: initialPath, close, sessionId, canWrite, rootPath = null, fragment = null }: {
  path: string; close: () => void; sessionId: string; canWrite: boolean;
  rootPath?: string | null; fragment?: string | null;
}) {
  const [path, setPath] = useState(initialPath);
  const panel = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [error, setError] = useState(''), [copied, setCopied] = useState<string | null>(null);
  useKeyboardLayer(panel, true, close);
  const insert = async (text: string, source?: HTMLElement) => {
    if (!canWrite) { setError('此会话仅允许查看'); return; }
    const accepted = await requestReferenceInsertion(text, sessionId, () => panel.current?.isConnected === true, source);
    if (accepted) close(); else setError('暂时无法添加到输入框，请稍后重试。');
  };
  return createPortal(
    <div data-sidebar-gesture-ignore
      className="fixed inset-0 z-modal-backdrop flex items-center justify-center bg-[var(--app-backdrop)] preview-safe-area [--preview-safe-area-gap:0.5rem] sm:[--preview-safe-area-gap:1.5rem]"
      onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label="文件预览"
        className="z-modal-panel flex h-full max-h-[90dvh] min-h-0 w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-surface text-foreground">
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-4">
          <span className="min-w-0 flex-1 truncate text-sm" title={path}>{path.split(/[\\/]/).pop()}</span>
          <button type="button" aria-label="关闭文件预览" className={button} onClick={close}><X size={17} /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          {error && <p role="alert" className="px-4 py-2 text-xs text-destructive">{error}</p>}
          <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">正在读取文件…</p>}>
            <Preview filePath={path} rootPath={rootPath} onFileSelect={setPath} initialMarkdownFragment={fragment} onClose={close}
              onInsertReference={(path, _key, source) => { void insert(buildReferenceInputText(path, null), source); }}
              onInsertText={(text, _key, source) => { void insert(text, source); }}
              onReferenceCopied={setCopied} isMobile={window.innerWidth < 640}
              markdownOutlineOpen={false} markdownImageLightboxOpen={false}
              lineRange={range} onLineRangeChange={setRange} insertedReferenceKey={null} copiedReferenceKey={copied} />
          </Suspense>
        </div>
      </div>
    </div>, document.body,
  );
}
