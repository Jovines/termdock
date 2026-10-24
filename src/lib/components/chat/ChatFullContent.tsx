import { useCallback, useMemo, useState } from 'react';
import { createParser, parseMessage, Renderer, type ActionEvent } from '@openuidev/react-lang';
import '@openuidev/react-ui/styles/index.css';
import './chatFullUI.css';
import { useSessionCapabilities, useShareAccess } from '../../federation/ShareAccessContext';
import { listDirectory, readFileContent } from '../../terminal/api';
import { resolveMarkdownLocalLinkTarget } from '../markdown/MarkdownPreview';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatFilePreview } from './ChatFilePreview';
import { useChatFileNavigation } from './ChatFileNavigation';
import { useChatUIState } from './useChatUIState';
import { chatUIActionText } from './chatUIActions';
import { FullUIContext, FullUITheme, chatFullUILibrary } from './chatFullUIRuntime';
import type { ChatMessage } from './chatMessages';

const parser = createParser(chatFullUILibrary.toJSONSchema(), chatFullUILibrary.root);
const QUERY_TOOLS = new Set(['read_file', 'list_directory']);
const MUTATION_TOOLS = new Set(['continue_conversation']);
export function ChatFullContent({ message, sessionId, canWrite, onAction }: {
  message: ChatMessage; sessionId: string; canWrite: boolean; onAction: (content: string) => Promise<boolean>;
}) {
  const ui = message.ui!, streaming = ui.streaming === true;
  const access = useShareAccess(), capabilities = useSessionCapabilities(), navigation = useChatFileNavigation();
  const [file, setFile] = useState<string>(), [error, setError] = useState(''), [acting, setActing] = useState(false), [invalid, setInvalid] = useState('');
  const parsed = useMemo(() => { try { return parser.parse(parseMessage(ui.code, { streaming }).content); } catch { return null; } }, [ui.code, streaming]);
  const permittedTools = !!parsed && parsed.queryStatements.every(tool => tool.toolAST?.k === 'Str' && QUERY_TOOLS.has(String(tool.toolAST.v)))
    && parsed.mutationStatements.every(tool => tool.toolAST?.k === 'Str' && MUTATION_TOOLS.has(String(tool.toolAST.v)));
  const valid = !!parsed && parsed.meta.statementCount <= 512 && permittedTools
    && (streaming || !!parsed.root && !parsed.meta.incomplete && !parsed.meta.errors.length && !parsed.meta.unresolved.length);
  const writable = canWrite && capabilities.has('session.input') && !streaming && !acting;
  const state = useChatUIState(sessionId, message.id, message.uiState, canWrite && capabilities.has('session.input') && !streaming && valid && !invalid);
  const canReadPath = useCallback((path: string) => capabilities.has('resource.files') && path.startsWith('/') && (access === undefined || !!access.directories?.some(grant => {
    const root = grant.path.replace(/\/$/, ''); return path === root || path.startsWith(`${root}/`);
  })), [access, capabilities]);
  const resolvePath = useCallback((value: unknown) => {
    if (typeof value !== 'string') throw new Error('文件路径无效');
    const target = resolveMarkdownLocalLinkTarget(value, navigation?.filePath ?? null, null);
    if (!target || !canReadPath(target.path)) throw new Error('文件未授权或路径无效');
    return target.path;
  }, [navigation?.filePath, canReadPath]);
  const openFile = useCallback((path: string) => { try { setFile(resolvePath(path)); } catch (failure) { setError((failure as Error).message); } }, [resolvePath]);
  const submit = useCallback(async (content: string) => {
    if (!canWrite || !capabilities.has('session.input') || streaming || acting) return false;
    setActing(true); setError('');
    try {
      if (!await state.save()) { setError('请先保存填写内容，再提交。'); return false; }
      if (!await onAction(content)) { setError('暂时无法提交，请稍后重试。'); return false; }
      return true;
    } finally { setActing(false); }
  }, [canWrite, capabilities, streaming, acting, state.save, onAction]);
  const action = useCallback(async (event: ActionEvent) => {
    if (!writable) return;
    if (event.type === 'open_url') {
      try { const url = new URL(String(event.params.url)); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); window.open(url.href, '_blank', 'noopener,noreferrer'); }
      catch { setError('链接无效，请确认地址。'); }
    } else if (event.type === 'continue_conversation') await submit(chatUIActionText(event, parsed?.root ?? null));
    else setError('此操作暂不可用，请通过消息说明。');
  }, [writable, parsed, submit]);
  const tools = useMemo(() => ({
    read_file: async (args: Record<string, unknown>) => readFileContent(resolvePath(args.path), AbortSignal.timeout(15000)),
    list_directory: async (args: Record<string, unknown>) => listDirectory(resolvePath(args.path), AbortSignal.timeout(15000)),
    continue_conversation: async (args: Record<string, unknown>) => {
      if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 32000) throw new Error('提交内容无效');
      const submitted = await submit(args.message); if (!submitted) throw new Error('消息未提交'); return { submitted };
    },
  }), [resolvePath, submit]);
  const context = useMemo(() => ({ canWrite: writable, canReadPath, openFile }), [writable, canReadPath, openFile]);
  if (!valid || invalid) return <div className="space-y-2"><ChatMarkdown content={message.content} /><p role={parsed && !permittedTools ? 'alert' : undefined} className="text-xs text-muted-foreground">{parsed && !permittedTools ? '界面请求的数据操作未注册或未获准，已显示文字说明' : '已显示文字说明'}</p></div>;
  return <ErrorBoundary fallback={<ChatMarkdown content={message.content} />}><FullUIContext.Provider value={context}><FullUITheme>
    <div data-chat-rich-content className="termdock-rich-ui min-w-0 space-y-3">
      <Renderer.Root library={chatFullUILibrary} response={ui.code} isStreaming={streaming || !canWrite || !capabilities.has('session.input') || acting}
        initialState={state.hydration} onStateUpdate={state.update} onAction={event => { void action(event); }} toolProvider={tools}
        publishObservability={false} onError={errors => { if (!streaming) { const fatal = errors.find(error => error.severity !== 'warning' && !['tool-error', 'tool-not-found', 'mcp-error'].includes(error.code)); if (fatal) setInvalid(fatal.message); } }}>
        <Renderer.Content />
        <Renderer.QueryLoading><p role="status" className="text-xs text-muted-foreground">正在读取数据…</p></Renderer.QueryLoading>
        <Renderer.QueryError><div role="alert" className="space-y-2 text-xs text-destructive"><p>数据读取失败，原有内容已保留。</p><Renderer.Retry className="min-h-11 rounded-lg border border-border px-3 text-foreground">重试读取</Renderer.Retry></div></Renderer.QueryError>
      </Renderer.Root>
      {streaming && <p role="status" className="text-xs text-muted-foreground">内容正在更新…</p>}
      {state.error ? <div role="alert" className="text-xs text-destructive">{state.error}<button type="button" className="ml-2 min-h-11 text-foreground" disabled={!writable} onClick={state.retry}>重新保存</button></div> : state.status && <p role="status" className="text-xs text-muted-foreground">{state.status}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {file && <ChatFilePreview path={file} sessionId={sessionId} canWrite={writable} close={() => setFile(undefined)} />}
    </div>
  </FullUITheme></FullUIContext.Provider></ErrorBoundary>;
}
