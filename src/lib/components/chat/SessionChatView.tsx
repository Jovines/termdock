import { clipboardEventContent } from '../../terminal/clipboardContent';
import { hasUnansweredMessage, mergeChatMessages, type ChatMessage } from './chatMessages';
import { readChatHistory } from './chatHistoryRequest';
import { SECURE_READY_EVENT } from '../../federation/connectionRecovery';
import { useAppFeedback } from '../ui/AppFeedback';
import { ChatLoading } from './ChatLoading';
import { loadChatRichContent } from './chatRenderers';
import { chatSnapshotGeneration, readChatSnapshot, saveChatSnapshot } from './chatSnapshot';
import { useChatViewport } from './useChatViewport';
import './sessionChat.css';
import { authorizeOwnedTerminalPaste } from '../../terminal/ownedPaste';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, LoaderCircle, MessageCircle, Paperclip, Quote, RefreshCw, TerminalSquare, X } from 'lucide-react';
import { currentSecureClient, savedConnection } from '../../federation/browserIntegration';
import { ChatTimeline, ChatReferenceCard, ChatUserMessage, ChatAgentLabel, chatTime } from './ChatTimeline';
import { composeChatContent, parseChatContent, type ChatReference } from './chatReferences';
import { useChatInputTransfer } from './useChatInputTransfer';
import { getTermdockDesktopBridge } from '../../desktop/nativeBridge';
import { writeTerminalClipboardText } from '../../terminal/clipboardText';
import { useShareAccess, useSessionCapabilities } from '../../federation/ShareAccessContext';
import { readFileReferenceDrag } from './fileReferenceTransfer';
import { getActiveKeyboardLayer } from '../../hooks/useKeyboardLayer';
interface Pending { content: string; requestId: string; createdAt: number }
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm transition hover:bg-surface-2 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
function SessionChatContent({ sessionId, name = '当前会话', canWrite: requestedWrite = true, active = true, terminalLink = false, onKeyboardChange, onReadyChange, onTerminal }: { sessionId: string; name?: string; canWrite?: boolean; active?: boolean; terminalLink?: boolean; onKeyboardChange?: (open: boolean) => void; onReadyChange?: (ready: boolean) => void; onTerminal: () => void }) {
  const capabilities = useSessionCapabilities();
  const canWrite = requestedWrite && capabilities.has('session.input');
  // The chat shell owns its loading/error UI. Showing it must not depend on
  // either an offscreen terminal handshake or the history request completing.
  useEffect(() => { onReadyChange?.(true); return () => onReadyChange?.(false); }, [onReadyChange]);
  const keyboardOpen = useChatViewport(active);
  const keyboardChanged = useRef(onKeyboardChange); keyboardChanged.current = onKeyboardChange;
  useEffect(() => { keyboardChanged.current?.(active && keyboardOpen); }, [active, keyboardOpen]);
  const storageKey = `termdock:chat:${savedConnection()?.targetPeerId || location.origin}:${sessionId}`;
  const [snapshot] = useState(() => readChatSnapshot(storageKey));
  const [hasOlder, setHasOlder] = useState(snapshot?.hasOlder ?? false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [replyPending, setReplyPending] = useState(snapshot?.replyPending);
  const [draft, setDraft] = useState(() => { try { return sessionStorage.getItem(`${storageKey}:draft`) || ''; } catch { return ''; } });
  const [reference, setReference] = useState<ChatReference | null>(() => { try { const value = JSON.parse(sessionStorage.getItem(`${storageKey}:reference`) || 'null'); return value && typeof value.author === 'string' && typeof value.time === 'string' && typeof value.text === 'string' ? value : null; } catch { return null; } });
  const [selectedReference, setSelectedReference] = useState<{ id: string; text: string } | null>(null);
  const [agentName, setAgentName] = useState(snapshot?.agentName ?? '助手');
  const [agentSlug, setAgentSlug] = useState<string | undefined>(snapshot?.agentSlug);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState<Pending | null>(() => { try { return JSON.parse(sessionStorage.getItem(`${storageKey}:pending`) || 'null'); } catch { return null; } });
  const [messages, setMessages] = useState<ChatMessage[]>(snapshot?.messages ?? []);
  const [loading, setLoading] = useState(!snapshot);
  const [agentAvailable, setAgentAvailable] = useState<boolean | undefined>(snapshot?.agentAvailable);
  const [error, setError] = useState('');
  const [syncInterrupted, setSyncInterrupted] = useState(false);
  const [historyReady, setHistoryReady] = useState(!!snapshot);
  useAppFeedback(active && syncInterrupted ? { tone: 'recovering', message: '正在恢复对话同步…' } : null);
  useAppFeedback(active && error ? { message: error } : null);
  const [sending, setSending] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const [copied, setCopied] = useState('');
  const scroll = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(snapshot?.nearBottom ?? true), busy = useRef(false), generation = useRef(0), refreshSequence = useRef(0);
  const content = useRef<HTMLDivElement>(null), section = useRef<HTMLElement>(null), filePicker = useRef<HTMLInputElement>(null), dragDepth = useRef(0);
  const pendingRequest = useRef(pending); pendingRequest.current = pending;
  const historyRevision = useRef<string>();
  const historyMessages = useRef(messages); historyMessages.current = messages;
  const pageState = useRef({ hasOlder: snapshot?.hasOlder ?? false, hasNewer: snapshot?.hasNewer ?? false });
  const olderBusy = useRef(false), olderAbort = useRef<AbortController>(), olderRetryAt = useRef(0), historyEpoch = useRef(0);
  const olderEdge = useRef<HTMLDivElement>(null);
  const [nearbyIds] = useState(() => new Set(snapshot?.visibleMessageIds));
  const [rowHeights] = useState(() => new Map(snapshot?.rowHeights));
  const scrollPosition = useRef(snapshot?.scrollTop ?? 0);
  const prepend = useRef<{ top: number; height: number }>();
  const inputScope = useRef({ active, canWrite, sessionId }); inputScope.current = { active, canWrite, sessionId };
  const access = useShareAccess();
  const insertText = useCallback((text: string, focus = true) => {
    const node = input.current, start = node?.selectionStart, end = node?.selectionEnd, scope = inputScope.current, client = currentSecureClient(), layer = getActiveKeyboardLayer();
    setDraft(current => {
      const at = Math.min(start ?? current.length, current.length), until = Math.min(end ?? at, current.length);
      const next = current.slice(0, at) + text + current.slice(until);
      requestAnimationFrame(() => { if (node?.isConnected && node.value === next && inputScope.current.active && inputScope.current.canWrite && inputScope.current.sessionId === scope.sessionId && currentSecureClient() === client && getActiveKeyboardLayer() === layer) { if (focus) node.focus({ preventScroll: true }); node.setSelectionRange(at + text.length, at + text.length); } });
      return next;
    });
  }, []);
  const transfer = useChatInputTransfer({ sessionId, active, canWrite, input, insert: insertText, error: setError,
    sessionAttachments: !!access,
    directory: access ? access.directories?.find(directory => directory.access === 'write')?.path : '/tmp' });
  const quoteMessage = useCallback((message: ChatMessage, selected?: string) => {
    if (!active || !canWrite) return;
    const text = selected || parseChatContent(message.content).text;
    if (new TextEncoder().encode(text).byteLength > 8000) { setError('这条消息较长，请选中需要引用的内容。'); return; }
    setSelectedReference(null);
    setReference({ author: message.role === 'user' ? '用户' : agentName, time: chatTime(message.createdAt), text });
    setError(''); window.getSelection()?.removeAllRanges(); input.current?.focus({ preventScroll: true });
  }, [active, canWrite, agentName]);
  useEffect(() => {
    if (!active || !canWrite) { setSelectedReference(null); return; }
    const changed = () => {
      const selection = window.getSelection(), text = selection?.toString().trim();
      const element = (node: Node | null | undefined) => node instanceof Element ? node : node?.parentElement;
      const from = element(selection?.anchorNode)?.closest<HTMLElement>('[data-chat-message]');
      const to = element(selection?.focusNode)?.closest<HTMLElement>('[data-chat-message]');
      const value = text && from === to && from && section.current?.contains(from) ? { id: from.dataset.chatMessage!, text } : null;
      setSelectedReference(previous => previous?.id === value?.id && previous?.text === value?.text ? previous : value);
    };
    document.addEventListener('selectionchange', changed); return () => document.removeEventListener('selectionchange', changed);
  }, [active, canWrite]);
  useEffect(() => { try { if (reference) sessionStorage.setItem(`${storageKey}:reference`, JSON.stringify(reference)); else sessionStorage.removeItem(`${storageKey}:reference`); } catch { /* Keep the current quote. */ } }, [storageKey, reference]);
  const endpoint = `/api/terminal/${encodeURIComponent(sessionId)}/chat`;
  const applyMessages = useCallback((items: ChatMessage[], replace = false) => {
    const next = mergeChatMessages(replace ? [] : historyMessages.current, items);
    historyMessages.current = next; setMessages(next);
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal, latest = false) => {
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]);
    const sequence = ++refreshSequence.current, client = currentSecureClient();
    const current = historyMessages.current, after = latest ? undefined : current[current.length - 1]?.id;
    const confirmation = pendingRequest.current ? { requestId: pendingRequest.current.requestId } : {};
    let payload;
    try { payload = await readChatHistory(sessionId, signal, latest ? undefined : historyRevision.current, { ...(after ? { after } : {}), ...confirmation }); }
    catch (failure) {
      if (!after || (failure as { status?: number }).status !== 404) throw failure;
      payload = await readChatHistory(sessionId, signal, undefined, confirmation); latest = true;
    }
    if (signal.aborted || sequence !== refreshSequence.current || currentSecureClient() !== client) return;
    if (payload.unchanged && payload.revision && payload.revision === historyRevision.current) { setLoading(false); setSyncInterrupted(false); setHistoryReady(true); return; }
    if (payload.page?.hasNewer && nearBottom.current && !pageState.current.hasNewer) {
      // A resumed reader following the live tail can jump straight to the
      // newest page instead of downloading a backlog before showing it.
      payload = await readChatHistory(sessionId, signal, undefined, confirmation); latest = true;
    }
    const items = payload.messages;
    if (!Array.isArray(items) || payload.updates !== undefined && !Array.isArray(payload.updates)) throw new Error('暂时无法读取对话，请重试');
    const incoming = [...payload.updates ?? [], ...items];
    if (incoming.some(message => message.ui)) await loadChatRichContent();
    if (signal.aborted || sequence !== refreshSequence.current || currentSecureClient() !== client) return;
    setAgentAvailable(payload.agentAvailable === true);
    setAgentName(typeof payload.agent?.displayName === 'string' && payload.agent.displayName.trim() ? payload.agent.displayName : '助手');
    setAgentSlug(typeof payload.agent?.slug === 'string' ? payload.agent.slug : undefined);
    historyRevision.current = typeof payload.revision === 'string' ? payload.revision : undefined;
    const replace = latest || current.length === 0;
    if (replace) {
      nearbyIds.clear();
      historyEpoch.current++; olderAbort.current?.abort();
      pageState.current.hasOlder = payload.page?.hasOlder === true; setHasOlder(pageState.current.hasOlder);
    }
    setReplyPending(payload.replyPending);
    pageState.current.hasNewer = payload.page?.hasNewer === true;
    const existing = new Set(current.map(message => message.id));
    if (pageState.current.hasNewer || current.length && !nearBottom.current && items.some(message => !existing.has(message.id))) setUnseen(true);
    applyMessages(incoming, replace);
    setPending(previous => previous && (payload.confirmedRequestId === previous.requestId || incoming.some(message => message.requestId === previous.requestId)) ? null : previous);
    setLoading(false); setSyncInterrupted(false); setHistoryReady(true);
  }, [sessionId, applyMessages, nearbyIds]);
  const loadOlder = useCallback(async () => {
    const before = historyMessages.current[0]?.id;
    if (!inputScope.current.active || !pageState.current.hasOlder || !before || olderBusy.current || Date.now() < olderRetryAt.current) return;
    const controller = new AbortController(), client = currentSecureClient(), epoch = historyEpoch.current;
    olderAbort.current = controller; olderBusy.current = true; setOlderLoading(true);
    try {
      const payload = await readChatHistory(sessionId, controller.signal, undefined, { before });
      if (!Array.isArray(payload.messages)) throw new Error('对话分页无效');
      if (payload.messages.some(message => message.ui)) await loadChatRichContent();
      if (controller.signal.aborted || currentSecureClient() !== client || epoch !== historyEpoch.current || !inputScope.current.active) return;
      const el = scroll.current;
      if (el) prepend.current = { top: el.scrollTop, height: el.scrollHeight };
      pageState.current.hasOlder = payload.page?.hasOlder === true; setHasOlder(pageState.current.hasOlder);
      applyMessages(payload.messages); olderRetryAt.current = 0;
    } catch (failure) {
      if (!controller.signal.aborted) {
        if ((failure as { status?: number }).status === 404) { pageState.current.hasOlder = false; setHasOlder(false); }
        else { olderRetryAt.current = Date.now() + 5000; setSyncInterrupted(true); }
      }
    } finally { if (olderAbort.current === controller) { olderBusy.current = false; olderAbort.current = undefined; if (inputScope.current.active) setOlderLoading(false); } }
  }, [sessionId, applyMessages]);
  useEffect(() => {
    const edge = olderEdge.current, root = scroll.current;
    if (!active || !hasOlder || !edge || !root) return;
    const resume = () => { olderRetryAt.current = 0; if (root.scrollTop < root.clientHeight) void loadOlder(); };
    window.addEventListener('online', resume);
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void loadOlder(); }, { root, rootMargin: `${root.clientHeight}px 0px` });
    observer?.observe(edge);
    return () => { observer?.disconnect(); window.removeEventListener('online', resume); };
  }, [active, hasOlder, messages.length, loadOlder]);
  useEffect(() => {
    if (!active) setOlderLoading(false);
    return () => { olderAbort.current?.abort(); olderAbort.current = undefined; olderBusy.current = false; };
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController(); let fetching = false, failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (fetching || document.visibilityState === 'hidden') return;
      clearTimeout(timer); fetching = true;
      try { await refresh(abort.signal); failures = 0; }
      catch { if (!abort.signal.aborted) { failures++; setSyncInterrupted(true); setLoading(false); } }
      finally {
        fetching = false;
        if (!abort.signal.aborted) timer = setTimeout(() => void poll(), Math.min(30_000, 2500 * 2 ** failures));
      }
    };
    void poll();
    window.addEventListener('online', poll); window.addEventListener(SECURE_READY_EVENT, poll); document.addEventListener('visibilitychange', poll);
    return () => { abort.abort(); clearTimeout(timer); window.removeEventListener('online', poll); window.removeEventListener(SECURE_READY_EVENT, poll); document.removeEventListener('visibilitychange', poll); };
  }, [active, refresh]);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { try { sessionStorage.setItem(`${storageKey}:draft`, draft); } catch { /* Storage may be unavailable. */ } }, [storageKey, draft]);
  useEffect(() => { try { if (pending) sessionStorage.setItem(`${storageKey}:pending`, JSON.stringify(pending)); else sessionStorage.removeItem(`${storageKey}:pending`); } catch { /* Keep the in-memory draft. */ } }, [storageKey, pending]);
  const bottom = useCallback(() => { const el = scroll.current; if (el && el.clientHeight) { el.scrollTop = el.scrollHeight; scrollPosition.current = el.scrollTop; nearBottom.current = true; if (!pageState.current.hasNewer) setUnseen(false); } }, []);
  useEffect(() => { if (!content.current || typeof ResizeObserver === 'undefined') return; const observer = new ResizeObserver(() => { if (inputScope.current.active && nearBottom.current) bottom(); }); observer.observe(content.current); if (scroll.current) observer.observe(scroll.current); return () => observer.disconnect(); }, [bottom]);
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!active || !el) return;
    if (prepend.current) {
      el.scrollTop = prepend.current.top + el.scrollHeight - prepend.current.height;
      scrollPosition.current = el.scrollTop; prepend.current = undefined;
    } else if (nearBottom.current) bottom();
    else el.scrollTop = scrollPosition.current;
  }, [messages, pending, active, hasOlder, bottom]);
  const snapshotState = useRef({ messages, agentName, agentSlug, agentAvailable, replyPending, hasOlder, hasNewer: pageState.current.hasNewer });
  snapshotState.current = { messages, agentName, agentSlug, agentAvailable, replyPending, hasOlder, hasNewer: pageState.current.hasNewer };
  useEffect(() => {
    const client = currentSecureClient(), cacheGeneration = chatSnapshotGeneration();
    return () => {
      const state = snapshotState.current;
      if (state.agentAvailable !== undefined && currentSecureClient() === client && cacheGeneration === chatSnapshotGeneration()) saveChatSnapshot(storageKey, { ...state, agentAvailable: state.agentAvailable, scrollTop: scrollPosition.current, nearBottom: nearBottom.current, rowHeights: [...rowHeights], visibleMessageIds: [...nearbyIds] });
    };
  }, [storageKey]);
  useLayoutEffect(() => { const el = input.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 176)}px`; } }, [draft, active]);
  useEffect(() => { const node = input.current; if (!node || typeof ResizeObserver === 'undefined') return; let previousWidth = 0; const observer = new ResizeObserver(() => { if (node.clientWidth === previousWidth) return; previousWidth = node.clientWidth; node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 176)}px`; }); observer.observe(node); return () => observer.disconnect(); }, []);
  const send = async (retry?: Pending, actionContent?: string): Promise<boolean> => {
    if (busy.current || transfer.busy || !inputScope.current.active || !inputScope.current.canWrite || agentAvailable !== true) return false;
    const item = retry || { content: actionContent ?? composeChatContent(draft, reference), requestId: crypto.randomUUID(), createdAt: Date.now() };
    if (!item.content || new TextEncoder().encode(item.content).byteLength > 32000) return false;
    busy.current = true; setSending(true); setError(''); setReplyPending(undefined); setPending(item); nearBottom.current = true;
    // The pending message owns this content now. Acknowledgements must never
    // clear the next draft, including one with the same text as this message.
    if (!retry && actionContent === undefined) { setDraft(''); setReference(null); }
    const attempt = generation.current;
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: item.content, requestId: item.requestId }), signal: AbortSignal.timeout(20000) });
      const payload = await response.json();
      if (!response.ok) throw new Error('发送失败，请重试。');
      if (attempt !== generation.current) return false;
      setPending(null);
      setMessages(current => current.some(m => m.id === payload.id) ? current : [...current, { ...item, id: payload.id, role: 'user', status: payload.status }]);
      try { await refresh(); } catch { setSyncInterrupted(true); }
      return true;
    } catch (failure) { if (attempt === generation.current) setError(failure instanceof Error && failure.name === 'TimeoutError' ? '发送状态待确认，请重试。' : '发送失败，请重试。'); return false; }
    finally { busy.current = false; if (attempt === generation.current) setSending(false); }
  };
  useEffect(() => { const insert = (event: Event) => { const detail = (event as CustomEvent<{ sessionId: string; text: string }>).detail; if (active && canWrite && detail.sessionId === sessionId) { insertText(detail.text); } }; window.addEventListener('termdock:chat-insert', insert); return () => window.removeEventListener('termdock:chat-insert', insert); }, [sessionId, active, canWrite, insertText]);
  useEffect(() => {
    if (!active) return;
    const insert = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; text?: string; nonce?: string; ownedPaste?: boolean; focus?: boolean }>).detail;
      if (!detail?.text || detail.sessionId !== sessionId) return;
      event.stopImmediatePropagation();
      const allowed = canWrite && (!detail.ownedPaste || !!authorizeOwnedTerminalPaste(detail, sessionId));
      if (allowed) { insertText(detail.text!, detail.focus !== false); }
      if (detail.nonce) window.dispatchEvent(new CustomEvent('termdock-insert-reference-ack', { detail: { nonce: detail.nonce, ok: allowed } }));
    };
    window.addEventListener('termdock-insert-reference', insert, true);
    return () => window.removeEventListener('termdock-insert-reference', insert, true);
  }, [sessionId, active, canWrite, insertText]);
  const sendLatest = useRef(send); sendLatest.current = send;
  const onAction = useCallback((content: string) => sendLatest.current(undefined, content), []);
  const onCopy = useCallback((text: string, id: string) => {
    void writeTerminalClipboardText(text, () => section.current?.isConnected === true).then(ok => { if (ok) setCopied(id); else setError('复制失败，请选择正文复制'); });
  }, []);
  const jumpLatest = async () => {
    if (pageState.current.hasNewer) {
      nearBottom.current = true;
      try { await refresh(undefined, true); } catch { setSyncInterrupted(true); }
    }
    bottom();
  };
  const waitingForReply = agentAvailable === true && !pending && (replyPending ?? hasUnansweredMessage(messages));
  const tooLong = new TextEncoder().encode(composeChatContent(draft, reference)).byteLength > 32000;
  return <section ref={section} data-session-chat onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; if (canWrite) setDragging(true); } }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = canWrite ? 'copy' : 'none'; } }} onDragLeave={event => { if (event.dataTransfer.types.includes('Files')) { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); } }} onDrop={event => { let draggedReference: string | null; try { draggedReference = readFileReferenceDrag(event.dataTransfer); } catch (error) { event.preventDefault(); setError(error instanceof Error ? error.message : '文件引用无效'); return; } if (draggedReference && canWrite) { event.preventDefault(); event.stopPropagation(); insertText(draggedReference); return; } const files = Array.from(event.dataTransfer.files); if (files.length) { event.preventDefault(); event.stopPropagation(); setDragging(false); dragDepth.current = 0; transfer.addFiles(files); } else if (canWrite && (event.target as Element).closest('[data-chat-composer]')) { const text = event.dataTransfer.getData('text/plain'); if (text) { event.preventDefault(); insertText(text); } } }} onKeyDown={e => e.stopPropagation()} className="session-chat relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--chrome-bg)] text-foreground" aria-label={`${name}对话`}>
    <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 [overflow-anchor:none] sm:px-8" onScroll={() => { const el = scroll.current!; if (!active || !el.clientHeight) return; scrollPosition.current = el.scrollTop; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96; if (nearBottom.current && !pageState.current.hasNewer) setUnseen(false); if (el.scrollTop < el.clientHeight) void loadOlder(); }}>
      <div ref={content} className="mx-auto flex min-h-full w-full max-w-screen-2xl flex-col py-5 sm:py-8">
        {hasOlder && <div ref={olderEdge} data-chat-older-edge aria-hidden="true" className="h-12 shrink-0">{olderLoading && <div className="space-y-2 py-2"><div className="chat-loading-skeleton h-3 w-3/4 rounded bg-surface-2" /><div className="chat-loading-skeleton h-3 w-1/2 rounded bg-surface-2" /></div>}</div>}
        {(loading || !historyReady) && !messages.length && !pending ? <ChatLoading /> : !messages.length && !pending ? <div className="my-auto py-6"><MessageCircle size={27} strokeWidth={1.5} className="mb-4 text-primary" /><h2 className="text-xl font-semibold tracking-tight sm:text-2xl">想一起完成什么？</h2><p className="mt-2 max-w-md text-[15px] leading-7 text-muted-foreground">直接描述你的目标，或从一个问题开始。</p>{!keyboardOpen && <div className="mt-5 flex flex-wrap gap-2">{['帮我梳理一下当前工作', '请解释一下刚才的结果', '我们继续下一步'].map(text => <button type="button" key={text} className={`${button} border border-border/60 text-left text-xs text-muted-foreground`} disabled={!canWrite} onClick={() => { setDraft(text); input.current?.focus({ preventScroll: true }); }}>{text}</button>)}</div>}</div> : <ChatTimeline pendingMessage={pending && <ChatUserMessage content={pending.content} createdAt={pending.createdAt} status={sending ? '发送中…' : '待重试'}>{!sending && <><button type="button" className="min-h-9 rounded-lg px-2 hover:bg-surface-2" onClick={() => { const parsed = parseChatContent(pending.content); setDraft(parsed.text); setReference(parsed.reference); setPending(null); setError(''); input.current?.focus({ preventScroll: true }); }}>修改草稿</button><button type="button" className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-primary hover:bg-surface-2" disabled={!canWrite || agentAvailable !== true} onClick={() => void send(pending)}><RefreshCw size={12} />重试发送</button></>}</ChatUserMessage>} sessionId={sessionId} uiWritable={active && canWrite && !pending && !sending && agentAvailable === true} onAction={onAction} messages={messages} scrollRoot={scroll} rowHeights={rowHeights} nearbyIds={nearbyIds} initialVisibleIds={snapshot?.visibleMessageIds} agentName={agentName} agentSlug={agentSlug} canWrite={canWrite} copied={copied} onReference={quoteMessage} onCopy={onCopy} />}

        {waitingForReply && !error && <div data-chat-reply-status role="status" aria-label={`${agentName}工作中`} aria-live="polite" className="mt-6 inline-flex w-fit max-w-full items-center gap-3 self-start rounded-lg border border-border/50 bg-[color-mix(in_srgb,var(--surface)_35%,var(--chrome-bg))] px-3 py-2 text-xs text-muted-foreground"><ChatAgentLabel name={agentName} slug={agentSlug} /><span className="inline-flex shrink-0 items-center gap-1.5"><LoaderCircle size={14} className="animate-spin text-primary motion-reduce:animate-none" /><span>工作中…</span></span></div>}
      </div>
    </div>
    {dragging && <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-surface/95 text-sm text-primary"><Paperclip size={18} className="mr-2" />松开以添加文件</div>}
    <div className="session-chat-composer relative shrink-0 px-3 pb-3 pt-1 sm:px-8 sm:pb-4">
      {unseen && <div className="flex justify-center pb-2"><button type="button" className={`${button} rounded-full border border-border bg-surface text-xs shadow-lg`} onClick={() => void jumpLatest()}><ArrowDown size={14} />查看新消息</button></div>}
      <div className="relative mx-auto max-w-screen-2xl">
      {agentAvailable === false && <div role="status" className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>当前对话暂不可用。</span><button type="button" className={button} onClick={onTerminal}><TerminalSquare size={14} />打开终端</button></div>}
      {selectedReference && <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 mb-2 flex justify-center"><div className="pointer-events-auto flex max-w-full items-center overflow-hidden rounded-xl border border-border bg-surface-2 shadow-lg transition-colors hover:bg-surface-elevated focus-within:bg-surface-elevated"><button type="button" aria-label="引用选中内容" className="inline-flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-l-xl px-3 py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onPointerDown={event => event.preventDefault()} onClick={() => { const message = messages.find(item => item.id === selectedReference.id); if (message) quoteMessage(message, selectedReference.text); }}><Quote size={13} className="shrink-0 text-primary" /><span className="shrink-0 text-primary">引用选中内容</span><span className="hidden min-w-0 max-w-sm truncate text-muted-foreground sm:block">{selectedReference.text}</span></button><button type="button" aria-label="取消选中引用" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-r-xl text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={() => { setSelectedReference(null); window.getSelection()?.removeAllRanges(); }}><X size={13} /></button></div></div>}
      {transfer.transfer && <div role="status" className="mb-2 flex min-h-9 items-center gap-2 px-1 text-xs text-muted-foreground">{transfer.busy && <LoaderCircle size={13} className="animate-spin text-primary" />}<span className="min-w-0 flex-1">{transfer.transfer.stage === 'reading' ? '正在读取剪贴板…' : transfer.transfer.stage === 'uploading' ? `正在上传文件${transfer.transfer.percent === undefined ? '…' : ` · ${transfer.transfer.percent}%`}` : transfer.transfer.stage === 'cancelled' ? '已取消上传' : '上传未完成，文件尚未添加'}</span>{transfer.busy ? <button type="button" className="min-h-9 px-2" onClick={transfer.cancel}>取消</button> : <><button type="button" className="min-h-9 px-2 text-primary" onClick={transfer.retry}>重试上传</button><button type="button" aria-label="关闭上传提示" className="min-h-9 px-2" onClick={transfer.dismiss}><X size={13} /></button></>}</div>}
      <form data-chat-composer className="rounded-2xl border border-border bg-surface p-2.5 transition-colors focus-within:border-primary/60" onSubmit={e => { e.preventDefault(); if (!pending) void send(); }}>
        {reference && <ChatReferenceCard reference={reference} onRemove={() => setReference(null)} />}
        <div className="flex items-end gap-2">
        <input ref={filePicker} type="file" multiple tabIndex={-1} className="hidden" aria-label="选择附件" onChange={event => { transfer.addFiles(Array.from(event.currentTarget.files || [])); event.currentTarget.value = ''; }} />
        <button type="button" aria-label="添加文件" title="添加文件，也可拖入或粘贴" className="mb-0.5 inline-flex h-10 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-surface-2 disabled:opacity-30" disabled={!canWrite || transfer.busy} onPointerDown={event => event.preventDefault()} onClick={() => filePicker.current?.click()}><Paperclip size={18} /></button>
        <textarea ref={input} onFocus={() => setSelectedReference(null)} onPaste={event => { const { files, text } = clipboardEventContent(event.clipboardData); if (files.length || getTermdockDesktopBridge()?.readClipboardFiles || !text && (getTermdockDesktopBridge() || typeof navigator.clipboard?.read === 'function')) { event.preventDefault(); void transfer.paste({ files, text }); } }} rows={1} autoComplete="off" className="session-chat-input min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-base leading-7 outline-none placeholder:text-muted-foreground/60" aria-label={`给${agentName}的消息`} placeholder={canWrite ? '输入消息…' : '此会话仅允许查看'} value={draft} disabled={!canWrite} onChange={e => setDraft(e.target.value)} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); if (!pending) void send(); } }} />
        <button type="submit" aria-label="发送消息" onPointerDown={e => { if (document.activeElement === input.current) e.preventDefault(); }} className="mb-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition hover:opacity-90 disabled:opacity-30" disabled={sending || transfer.busy || !!pending || !draft.trim() || tooLong || !canWrite || agentAvailable !== true}><ArrowUp size={19} /></button>
        </div>
      </form>
      {tooLong ? <p className="mt-2 px-1 text-xs text-destructive">消息过长，请缩短后发送。</p> : !canWrite ? <p className="mt-2 px-1 text-[11px] text-muted-foreground">仅查看</p> : !keyboardOpen && <p className="session-chat-keyboard-hint mt-2 hidden px-1 text-[11px] text-muted-foreground/60 sm:block">Enter 发送 · Shift + Enter 换行</p>}
      {terminalLink && <div className="mt-1 flex justify-end"><button type="button" className={`${button} min-h-9 px-2 text-xs text-muted-foreground`} onClick={onTerminal}><TerminalSquare size={13} />查看终端</button></div>}</div>
    </div>
  </section>;
}

/** A changed session or service starts a separate draft, request and viewport. */
export function SessionChatView(props: Parameters<typeof SessionChatContent>[0]) {
  return <SessionChatContent key={`${savedConnection()?.targetPeerId || location.origin}:${props.sessionId}`} {...props} />;
}
