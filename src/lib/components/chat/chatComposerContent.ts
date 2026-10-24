export interface ChatAttachment { path: string; name: string; type?: string; size?: number; reference?: string }
export interface ChatInsertionPoint { value: string; start: number; end: number }
export interface ChatMention { sessionId: string; groupId: string; groupName: string; name: string; subtitle?: string }
export interface ChatComposerContent { text: string; attachments: ChatAttachment[]; mentions: ChatMention[] }
const marker = '```termdock-context\n';
export const mentionToken = (member: ChatMention) => `@「${member.name} · ${member.groupName}」`;
export const attachmentToken = (file: ChatAttachment) => file.reference ? `【${file.reference}】` : '';
export function activeChatMentions(text: string, mentions: ChatMention[]): ChatMention[] {
  return mentions.filter(member => text.includes(mentionToken(member)));
}
/** A readable text envelope keeps attachments and routing usable by existing Agents. */
export function composeChatDraft(text: string, attachments: ChatAttachment[], mentions: ChatMention[]): string {
  const active = activeChatMentions(text, mentions);
  const body = text.trim();
  return body + (attachments.length || active.length ? `${body ? '\n\n' : ''}${marker}${JSON.stringify({ attachments, mentions: active })}\n\`\`\`` : '');
}
export function parseChatDraft(content: string): ChatComposerContent {
  const plain = { text: content, attachments: [], mentions: [] };
  const at = content.lastIndexOf(marker);
  if (at < 0 || at > 0 && !content.slice(0, at).endsWith('\n\n') || !content.endsWith('\n```')) return plain;
  try {
    const value = JSON.parse(content.slice(at + marker.length, -4));
    if (!Array.isArray(value.attachments) || !Array.isArray(value.mentions)
      || !value.attachments.every((a: ChatAttachment) => a && typeof a.path === 'string' && typeof a.name === 'string' && (a.type === undefined || typeof a.type === 'string') && (a.size === undefined || typeof a.size === 'number') && (a.reference === undefined || typeof a.reference === 'string'))
      || !value.mentions.every((m: ChatMention) => m && ['sessionId', 'groupId', 'groupName', 'name'].every(key => typeof m[key as keyof ChatMention] === 'string') && (m.subtitle === undefined || typeof m.subtitle === 'string'))) return plain;
    return { text: content.slice(0, at ? at - 2 : 0), attachments: value.attachments, mentions: value.mentions };
  } catch { return plain; }
}
export function chatAttachmentKind(file: ChatAttachment): '图片' | '视频' | '文件' {
  if (file.type?.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|avif|svg)$/i.test(file.name)) return '图片';
  if (file.type?.startsWith('video/') || /\.(mp4|mov|webm|m4v|mkv)$/i.test(file.name)) return '视频';
  return '文件';
}
export function chatDraftSummary(content: string): string {
  const draft = parseChatDraft(content);
  return [draft.text, ...draft.attachments.map(file => `${file.reference || chatAttachmentKind(file)}：${file.name}`)].filter(Boolean).join('\n');
}
