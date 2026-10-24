import { FileText, Image, Video } from 'lucide-react';
import { attachmentToken, chatAttachmentKind, mentionToken, type ChatAttachment, type ChatMention } from './chatComposerContent';

export const chatInlineTokenClass = 'mx-0.5 inline-flex min-h-8 max-w-full translate-y-[-1px] items-center gap-1 rounded-lg border border-border/60 bg-surface-2 px-2 py-0.5 align-baseline text-sm text-primary';
export const chatInlineTokenTitleClass = 'max-w-[12rem] truncate';
export const chatInlineTitle = (part: ChatInlinePart) => part.file && chatAttachmentKind(part.file) !== '文件' ? part.file.reference || chatAttachmentKind(part.file) : chatInlineLabel(part);
export const chatInlineLabel = (part: ChatInlinePart) => part.file ? `${part.file.reference} · ${part.file.name}` : `@${part.member!.name}`;

export interface ChatInlinePart { text: string; token?: string; file?: ChatAttachment; member?: ChatMention }
export function chatInlineParts(text: string, files: ChatAttachment[], members: ChatMention[]): ChatInlinePart[] {
  const choices = [
    ...files.filter(file => file.reference).map(file => ({ token: attachmentToken(file), file })),
    ...members.map(member => ({ token: mentionToken(member), member })),
  ].filter(item => item.token).sort((a, b) => b.token.length - a.token.length);
  const parts: ChatInlinePart[] = [];
  let rest = text;
  while (rest) {
    let index = rest.length, found: typeof choices[number] | undefined;
    for (const item of choices) { const at = rest.indexOf(item.token); if (at >= 0 && at < index) { index = at; found = item; } }
    if (!found) { parts.push({ text: rest }); break; }
    if (index) parts.push({ text: rest.slice(0, index) });
    parts.push({ text: found.token, token: found.token, ...('file' in found ? { file: found.file } : { member: found.member }) });
    rest = rest.slice(index + found.token.length);
  }
  return parts;
}

/** Use the editor's inline ordering and chip geometry in sent and pending messages. */
export function ChatInlineContent({ text, files, mentions, onPreview }: { text: string; files: ChatAttachment[]; mentions: ChatMention[]; onPreview?: (file: ChatAttachment) => void }) {
  return <>{chatInlineParts(text, files, mentions).map((part, index) => {
    if (!part.file && !part.member) return part.text;
    const label = chatInlineLabel(part), kind = part.file ? chatAttachmentKind(part.file) : undefined;
    const Icon = kind === '图片' ? Image : kind === '视频' ? Video : FileText;
    const body = <><Icon size={13} aria-hidden="true" className="shrink-0" /><span className={chatInlineTokenTitleClass}>{chatInlineTitle(part)}</span></>;
    return <span key={index} role="group" aria-label={`${part.file ? '附件' : '提及'} ${label}`} data-chat-inline-token={part.token} data-chat-inline-kind={part.file ? 'attachment' : 'mention'} className={chatInlineTokenClass} title={label}>
      {(kind === '图片' || kind === '视频') && onPreview ? <button type="button" aria-label={`预览${kind} ${part.file!.name}`} title={label} className="inline-flex min-w-0 items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onPointerDown={event => event.preventDefault()} onClick={() => onPreview(part.file!)}>{body}</button> : body}
    </span>;
  })}</>;
}
