import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Bot, Check, Copy, Quote, X } from 'lucide-react';
import { chatTurns, chatSendStatus, type ChatMessage } from './chatMessages';
import { parseChatContent, type ChatReference } from './chatReferences';
import { ChatMessageViewport } from './ChatMessageViewport';
import { ChatMarkdown } from './ChatMarkdown';
import { getChatRichContent } from './chatRenderers';
import { attachmentToken } from './chatComposerContent';
import { parseChatDisplayDraft } from './chatDisplayContent';
import { ChatAttachmentCards } from './ChatAttachmentCards';
import { useChatAttachmentPreview } from './useChatAttachmentPreview';
import { ChatInlineContent } from './ChatInlineContent';
export const chatTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const builtInIcons = new Set(['amp', 'claude', 'codex', 'copilot', 'cursor', 'droid', 'gemini', 'goose', 'grok', 'kimi', 'opencode']);
export function ChatAgentLabel({ name, slug }: { name: string; slug?: string }) {
  const icon = slug && builtInIcons.has(slug) ? `url(/icons/agents/${slug}.svg) center / contain no-repeat` : undefined;
  return <span className="inline-flex items-center gap-2 font-medium text-foreground/75">{icon ? <span aria-hidden="true" className="h-4 w-4 shrink-0 bg-current" style={{ mask: icon, WebkitMask: icon }} /> : <Bot size={15} aria-hidden="true" />}<span>{name}</span></span>;
}
export function ChatReferenceCard({ reference, onRemove }: { reference: ChatReference; onRemove?: () => void }) {
  return <blockquote className="mb-2 min-w-0 rounded-lg border-l-2 border-primary/50 bg-surface px-3 py-2 text-left">
    <div className="flex items-center gap-2 text-[11px] leading-5 text-muted-foreground"><Quote size={12} /><span className="min-w-0 flex-1 truncate">{reference.author} · {reference.time}</span>{onRemove && <button type="button" aria-label="移除消息引用" title="移除引用" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-surface-2" onPointerDown={e => e.preventDefault()} onClick={onRemove}><X size={13} /></button>}</div>
    <p className="line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground/75" title={reference.text}>{reference.text}</p>
  </blockquote>;
}
export function ChatUserContent({ content }: { content: string }) {
  const parsed = parseChatContent(content);
  const draft = parseChatDisplayDraft(parsed.text);
  const { onPreview, preview } = useChatAttachmentPreview(draft.attachments);
  const separateFiles = draft.attachments.filter(file => !file.reference || !draft.text.includes(attachmentToken(file)));
  return <>{parsed.reference && <ChatReferenceCard reference={parsed.reference} />}<ChatAttachmentCards files={separateFiles} onPreview={onPreview} />{draft.text && <p className="whitespace-pre-wrap break-words text-base leading-7"><ChatInlineContent text={draft.text} files={draft.attachments} mentions={draft.mentions} onPreview={onPreview} /></p>}{preview}</>;
}
export function ChatUserMessage({ content, createdAt, status, messageId, actionsOpen, children }: { content: string; createdAt: number; status: string; messageId?: string; actionsOpen?: boolean; children?: ReactNode }) {
  return <article data-chat-turn="user" data-chat-message={messageId} data-actions-open={actionsOpen || undefined} className="ml-auto flex w-fit max-w-[88%] flex-col items-end sm:max-w-[85%]">
    <div data-chat-user-bubble className="w-fit max-w-full rounded-2xl bg-surface-2 px-4 py-3"><ChatUserContent content={content} /></div>
    <div data-chat-message-actions className="chat-user-meta mt-1 flex min-h-8 flex-wrap items-center justify-end gap-2 text-[10px] text-muted-foreground">
      <span>{status}</span><time dateTime={new Date(createdAt).toISOString()} title={new Date(createdAt).toLocaleString()} className="opacity-60">{chatTime(createdAt)}</time>{children}
    </div>
  </article>;
}
const action = 'chat-message-action inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg text-muted-foreground/60 transition hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring';
export const ChatTimeline = memo(function ChatTimeline({ messages, agentName, agentSlug, canWrite, copied, onCopy, onReference, sessionId, uiWritable, onAction, pendingMessage, scrollRoot, rowHeights, nearbyIds, initialVisibleIds }: {
  scrollRoot?: RefObject<HTMLDivElement>; rowHeights?: Map<string, number>; nearbyIds?: Set<string>; initialVisibleIds?: string[];
  sessionId: string; uiWritable: boolean; onAction: (content: string) => Promise<boolean>;
  messages: ChatMessage[]; agentName: string; agentSlug?: string; canWrite: boolean; copied: string;
  pendingMessage?: ReactNode;
  onCopy: (text: string, id: string) => void; onReference: (message: ChatMessage) => void;
}) {
  const eager = useMemo(() => new Set([...initialVisibleIds ?? [], ...messages.slice(-6).map(message => message.id)]), [messages, initialVisibleIds]);
  const estimate = (message: ChatMessage) => Math.min(1200, Math.max(80, Math.ceil(message.content.length / 65) * 28 + 40));
  const RichContent = getChatRichContent();
  const groupKeys = useRef(new Map<string, string>());
  const turns = useMemo(() => chatTurns(messages).map(turn => {
    if (turn.role === 'user') return turn;
    const id = turn.messages.map(message => groupKeys.current.get(message.id)).find(Boolean) || turn.id;
    for (const message of turn.messages) groupKeys.current.set(message.id, id);
    return { ...turn, id };
  }), [messages]);
  const [openActions, setOpenActions] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pointerType = useRef('');
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpenActions(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenActions(null); };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, []);
  return <div ref={root} className="space-y-6 sm:space-y-7" onPointerDownCapture={event => { pointerType.current = event.pointerType; }} onClick={event => {
    // Touch users reveal the same actions as hover, without intercepting text
    // selection, links, or controls rendered inside Markdown/OpenUI messages.
    if (!event.detail || (pointerType.current !== 'touch' && !window.matchMedia?.('(hover: none)').matches)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest('button, a, input, textarea, select, label, summary, [role="button"], [contenteditable="true"]')) return;
    if (window.getSelection()?.toString().trim()) return;
    const id = target.closest<HTMLElement>('[data-chat-message]')?.dataset.chatMessage;
    setOpenActions(current => id && current !== id ? id : null);
  }}>{turns.map(turn => {
    const last = turn.messages[turn.messages.length - 1], user = turn.role === 'user';
    const text = turn.messages.map(message => message.content).join('\n\n');
    const quote = (message: ChatMessage) => canWrite && <button type="button" aria-label="引用消息" title="引用这条消息" className={`${action} shrink-0`} onPointerDown={e => e.preventDefault()} onClick={() => { setOpenActions(null); onReference(message); }}><Quote size={13} /></button>;
    if (user) return <ChatMessageViewport key={turn.id} id={turn.id} root={scrollRoot} heights={rowHeights} nearby={nearbyIds} estimate={estimate(last)} eager={eager.has(last.id)}><ChatUserMessage messageId={turn.id} actionsOpen={openActions === turn.id} content={text} createdAt={last.createdAt} status={chatSendStatus(last.status)}><span className="chat-message-tools">{quote(last)}
      <button type="button" className={action} aria-label="复制消息" title="复制" onClick={() => onCopy(text, turn.id)}>{copied === turn.id ? <Check size={13} /> : <Copy size={13} />}{copied === turn.id && <span className="text-[10px]">已复制</span>}</button>
    </span></ChatUserMessage></ChatMessageViewport>;
    return <article key={turn.id} data-chat-turn="assistant" className="w-full">
      <div className="mb-2 flex min-h-8 items-center text-[11px] leading-4"><ChatAgentLabel name={agentName} slug={agentSlug} /></div>
      <div className="chat-replies min-w-0">{turn.messages.map((message, index) => <ChatMessageViewport key={message.id} id={message.id} root={scrollRoot} heights={rowHeights} nearby={nearbyIds} estimate={estimate(message)} eager={eager.has(message.id)} preserve={!!message.ui}><div data-chat-message={message.id} data-actions-open={openActions === message.id || undefined} className="chat-reply min-w-0">
        <div className="session-chat-markdown min-w-0 break-words">
          {message.ui && RichContent ? <RichContent key={message.id} message={message} sessionId={sessionId} canWrite={uiWritable} onAction={onAction} /> : <ChatMarkdown content={message.content} />}
        </div>
        <div data-chat-message-actions className="chat-reply-meta flex items-center justify-between gap-2">
          <span className="chat-message-tools">{quote(message)}<button type="button" className={action} aria-label="复制回复" title="复制" onClick={() => onCopy(message.content, message.id)}>{copied === message.id ? <Check size={13} /> : <Copy size={13} />}{copied === message.id && <span className="text-[10px]">已复制</span>}</button></span>
          {index < turn.messages.length - 1 && <span aria-hidden="true" className="chat-reply-divider min-w-0 flex-1" />}
          <time className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60" dateTime={new Date(message.createdAt).toISOString()} title={new Date(message.createdAt).toLocaleString()}>{chatTime(message.createdAt)}</time>
        </div>
      </div></ChatMessageViewport>)}</div>
    </article>;
  })}{pendingMessage}</div>;
});
