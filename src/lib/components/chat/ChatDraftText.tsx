import { attachmentToken, mentionToken, type ChatAttachment, type ChatMention } from './chatComposerContent';
/** Paint the native textarea's exact text geometry; decorations never add width. */
export function ChatDraftText({ text, files, mentions }: { text: string; files: ChatAttachment[]; mentions: ChatMention[] }) {
  const tokens = [...files.map(attachmentToken), ...mentions.map(mentionToken)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!tokens.length) return <>{text}</>;
  const parts: { text: string; token: boolean }[] = [];
  let rest = text;
  while (rest) {
    let at = rest.length, found = '';
    for (const token of tokens) { const index = rest.indexOf(token); if (index >= 0 && index < at) { at = index; found = token; } }
    if (!found) { parts.push({ text: rest, token: false }); break; }
    if (at) parts.push({ text: rest.slice(0, at), token: false });
    parts.push({ text: found, token: true }); rest = rest.slice(at + found.length);
  }
  return <>{parts.map((part, index) => part.token ? <span key={index} className="rounded bg-primary/10 text-primary">{part.text}</span> : <span key={index}>{part.text}</span>)}</>;
}
