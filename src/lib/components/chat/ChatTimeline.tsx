import { lazy, Suspense } from 'react';
import { Check, Copy, Quote, X } from 'lucide-react';
import { chatTurns, chatSendStatus, type ChatMessage } from './chatMessages';
import { parseChatContent, type ChatReference } from './chatReferences';
const Markdown = lazy(() => import('../markdown/MarkdownPreview').then(m => ({ default: m.MarkdownPreview })));
export const chatTime = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function ChatReferenceCard({ reference, onRemove }: { reference: ChatReference; onRemove?: () => void }) {
  return <blockquote className="mb-2 min-w-0 rounded-lg border-l-2 border-primary/50 bg-surface px-3 py-2 text-left">
    <div className="flex items-center gap-2 text-[11px] leading-5 text-muted-foreground"><Quote size={12} /><span className="min-w-0 flex-1 truncate">{reference.author} · {reference.time}</span>{onRemove && <button type="button" aria-label="移除消息引用" title="移除引用" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-surface-2" onPointerDown={e => e.preventDefault()} onClick={onRemove}><X size={13} /></button>}</div>
    <p className="line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground/75" title={reference.text}>{reference.text}</p>
  </blockquote>;
}
export function ChatUserContent({ content }: { content: string }) {
  const parsed = parseChatContent(content);
  return <>{parsed.reference && <ChatReferenceCard reference={parsed.reference} />}<p className="whitespace-pre-wrap break-words text-[15px] leading-7 sm:text-base">{parsed.text}</p></>;
}
const action = 'inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg text-muted-foreground/60 transition hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring';
export function ChatTimeline({ messages, agentName, canWrite, copied, onCopy, onReference }: {
  messages: ChatMessage[]; agentName: string; canWrite: boolean; copied: string;
  onCopy: (text: string, id: string) => void; onReference: (message: ChatMessage) => void;
}) {
  return <div className="space-y-6 sm:space-y-7">{chatTurns(messages).map(turn => {
    const last = turn.messages[turn.messages.length - 1], user = turn.role === 'user';
    const text = turn.messages.map(message => message.content).join('\n\n');
    const quote = (message: ChatMessage) => canWrite && <button type="button" aria-label="引用消息" title="引用这条消息" className={`${action} shrink-0`} onPointerDown={e => e.preventDefault()} onClick={() => onReference(message)}><Quote size={13} /></button>;
    return <article key={turn.id} data-chat-turn={turn.role} data-chat-message={user ? turn.id : undefined} className={user ? 'ml-auto w-fit max-w-[88%] sm:max-w-[85%]' : 'w-full'}>
      {user ? <div className="rounded-2xl bg-surface-2 px-4 py-3"><ChatUserContent content={text} /></div> : <div className="session-chat-markdown min-w-0 space-y-4 break-words">{turn.messages.map((message, index) => <div key={message.id} data-chat-message={message.id}>
        <div data-chat-continuation={index > 0 ? '' : undefined} className={`mb-2 flex min-h-8 items-center gap-3 text-[11px] leading-4 text-muted-foreground/60 ${index > 0 ? 'pt-1' : ''}`}>
          {index === 0 && <span className="font-medium text-foreground/75">{agentName}</span>}
          {index > 0 ? <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-border/60" /> : <span className="flex-1" />}
          <time className="shrink-0 tabular-nums" dateTime={new Date(message.createdAt).toISOString()} title={new Date(message.createdAt).toLocaleString()}>{chatTime(message.createdAt)}</time>{quote(message)}
        </div>
        <Suspense fallback={<p className="whitespace-pre-wrap text-[15px] leading-7">{message.content}</p>}><Markdown embedded referenceLines={false} content={message.content} filePath={null} rootPath={null} lineRange={null} onLineRangeClick={() => {}} scrollTop={0} outlineOpen={false} lightboxOpen={false} /></Suspense>
      </div>)}</div>}
      <div className={`mt-1 flex items-center gap-2 text-[10px] text-muted-foreground ${user ? 'justify-end' : ''}`}>{user && <><span>{chatSendStatus(last.status)}</span><time dateTime={new Date(last.createdAt).toISOString()} title={new Date(last.createdAt).toLocaleString()} className="opacity-60">{chatTime(last.createdAt)}</time>{quote(last)}</>}
        <button type="button" className={action} aria-label={user ? '复制消息' : '复制回复'} title="复制" onClick={() => onCopy(text, turn.id)}>{copied === turn.id ? <Check size={13} /> : <Copy size={13} />}{copied === turn.id && <span className="text-[10px]">已复制</span>}</button>
      </div>
    </article>;
  })}</div>;
}
