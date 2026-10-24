import { findTerminalPathMatches, resolveTerminalPath } from '../../terminal/pathLinks';
import { attachmentToken, chatAttachmentKind, parseChatDraft, type ChatAttachment } from './chatComposerContent';

/** Project older plain video paths into inline media without rewriting history. */
export function parseChatDisplayDraft(content: string) {
  const draft = parseChatDraft(content), attachments = [...draft.attachments];
  const paths: { start: number; end: number; path: string }[] = [];
  // Quoted paths may contain unescaped spaces; shell words use the terminal's
  // existing path scanner so escaped spaces and prose punctuation stay intact.
  for (const match of draft.text.matchAll(/(["'])(\/[^"'\r\n]+\.(?:mp4|mov|webm|m4v|mkv))\1/gi)) {
    paths.push({ start: match.index, end: match.index + match[0].length, path: match[2] });
  }
  for (const match of findTerminalPathMatches(draft.text)) {
    if (!match.text.startsWith('/') || match.line || paths.some(path => match.startIndex < path.end && match.endIndex > path.start)) continue;
    const path = resolveTerminalPath(match.text.replace(/\\(.)/g, '$1'), null);
    if (path) paths.push({ start: match.startIndex, end: match.endIndex, path });
  }
  let number = Math.max(0, ...attachments.map(file => Number(file.reference?.match(/\d+$/)?.[0]) || 0));
  let text = '', at = 0;
  for (const match of paths.sort((a, b) => a.start - b.start)) {
    const name = match.path.split('/').pop()!;
    if (chatAttachmentKind({ path: match.path, name }) !== '视频') continue;
    const existing = attachments.findIndex(file => file.path === match.path);
    let file: ChatAttachment;
    if (existing >= 0) {
      file = attachments[existing];
      if (!file.reference) { file = { ...file, reference: `视频${++number}` }; attachments[existing] = file; }
    } else { file = { path: match.path, name, reference: `视频${++number}` }; attachments.push(file); }
    text += draft.text.slice(at, match.start) + attachmentToken(file); at = match.end;
  }
  return { ...draft, text: text + draft.text.slice(at), attachments };
}
