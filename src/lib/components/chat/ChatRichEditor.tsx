import { useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent, type RefObject } from 'react';
import { attachmentToken, chatAttachmentKind, mentionToken, type ChatAttachment, type ChatMention } from './chatComposerContent';

interface Part { text: string; token?: string; file?: ChatAttachment; member?: ChatMention }
function partsFor(text: string, files: ChatAttachment[], members: ChatMention[]): Part[] {
  const choices = [
    ...files.filter(file => file.reference).map(file => ({ token: attachmentToken(file), file })),
    ...members.map(member => ({ token: mentionToken(member), member })),
  ].filter(item => item.token).sort((a, b) => b.token.length - a.token.length);
  const parts: Part[] = [];
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
function isBlock(node: Node): boolean { return node instanceof HTMLElement && (node.tagName === 'DIV' || node.tagName === 'P'); }
function serializeChildren(parent: Node): string {
  let text = '', previousBlock = false;
  for (const child of [...parent.childNodes]) {
    const block = isBlock(child);
    if (block && previousBlock || block && text) text += '\n';
    if (block && child instanceof HTMLElement && child.childNodes.length === 1 && child.firstChild instanceof HTMLElement && child.firstChild.tagName === 'BR') {
      // Browsers use a lone BR as the caret placeholder in an empty paragraph.
    } else text += serializeNode(child);
    previousBlock = block;
  }
  return text;
}
function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
  if (!(node instanceof HTMLElement)) return serializeChildren(node);
  const token = node.dataset.chatInlineToken;
  if (token) return token;
  if (node.tagName === 'BR') return node.dataset.chatPlaceholder === 'true' ? '' : '\n';
  return serializeChildren(node);
}
export function readChatEditor(node: HTMLElement): { text: string; value: string; start: number; end: number } {
  const text = serializeChildren(node);
  const selection = getSelection();
  if (!selection?.rangeCount || !node.contains(selection.anchorNode)) return { text, value: text, start: text.length, end: text.length };
  const measure = (container: Node, offset: number) => {
    const before = document.createRange(); before.selectNodeContents(node);
    try { before.setEnd(container, offset); }
    catch { return text.length; }
    return Math.min(text.length, serializeChildren(before.cloneContents()).length);
  };
  const anchor = measure(selection.anchorNode!, selection.anchorOffset);
  const focus = measure(selection.focusNode!, selection.focusOffset);
  return { text, value: text, start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}
export function setChatEditorCaret(node: HTMLElement, offset: number): void {
  const selection = getSelection(); if (!selection) return;
  const range = document.createRange(); let remaining = Math.max(0, offset), placed = false;
  const visit = (parent: Node): void => {
    let hadContent = false;
    for (const child of [...parent.childNodes]) {
      if (placed) return;
      if (isBlock(child) && hadContent) {
        if (remaining <= 1) { range.setStartBefore(child); placed = true; return; }
        remaining--;
      }
      if (child instanceof HTMLElement && child.dataset.chatInlineToken) {
        const length = child.dataset.chatInlineToken.length;
        if (remaining <= 0) { range.setStartBefore(child); placed = true; return; }
        if (remaining < length) { range.setStartAfter(child); placed = true; return; }
        remaining -= length;
        hadContent = true;
      } else if (child.nodeType === Node.TEXT_NODE) {
        const length = child.textContent?.length ?? 0;
        if (remaining <= length) { range.setStart(child, remaining); placed = true; return; }
        remaining -= length;
        hadContent ||= length > 0;
      } else if (child instanceof HTMLElement && child.tagName === 'BR') {
        if (remaining === 0) { range.setStartBefore(child); placed = true; return; }
        remaining--;
        hadContent = true;
      } else { visit(child); hadContent ||= isBlock(child); }
    }
  };
  visit(node);
  if (!placed) range.selectNodeContents(node), range.collapse(false); else range.collapse(true);
  selection.removeAllRanges(); selection.addRange(range);
}

export function ChatRichEditor({ input, value, files, mentions, placeholder, readOnly = false, masked = false,
  label, onInput, onKeyDown, onPaste, onFocus, onTokenRemove }: {
  input: RefObject<HTMLDivElement>; value: string; files: ChatAttachment[]; mentions: ChatMention[];
  placeholder: string; label: string; readOnly?: boolean; masked?: boolean;
  onInput: (text: string, start: number, end: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  onFocus: () => void; onTokenRemove: (token: string) => void;
}) {
  const lastSelection = useRef<number | null>(null);
  useLayoutEffect(() => {
    const node = input.current; if (!node) return;
    const desired = partsFor(value, files, mentions);
    const hasExpectedChips = desired.filter(part => part.file || part.member).every(part => [...node.querySelectorAll<HTMLElement>('[data-chat-inline-token]')].some(chip => chip.dataset.chatInlineToken === part.token));
    if (readChatEditor(node).text === value && hasExpectedChips) return;
    node.replaceChildren();
    for (const part of desired) {
      if (part.file || part.member) {
        const token = part.token!, kind = part.file ? chatAttachmentKind(part.file) : undefined;
        const label = part.file ? `${part.file.reference} · ${part.file.name}` : `@${part.member!.name}`;
        const chip = document.createElement('span'); chip.contentEditable = 'false'; chip.dataset.chatInlineToken = token;
        chip.dataset.chatInlineKind = part.file ? 'attachment' : 'mention'; chip.setAttribute('role', 'group');
        chip.setAttribute('aria-label', part.file ? `附件 ${label}` : `提及 ${label}`);
        chip.className = 'mx-0.5 inline-flex max-w-full translate-y-[-1px] items-center gap-1 rounded-lg border border-border/60 bg-surface-2 px-2 py-0.5 align-baseline text-sm text-primary';
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('width', '13'); icon.setAttribute('height', '13'); icon.setAttribute('class', 'shrink-0'); icon.innerHTML = kind === '图片' ? '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>' : kind === '视频' ? '<path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2"/>' : '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>'; icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '2'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round'); chip.append(icon);
        const title = document.createElement('span'); title.className = 'max-w-[12rem] truncate'; title.textContent = label; chip.append(title);
        if (!readOnly) { const remove = document.createElement('button'); remove.type = 'button'; remove.setAttribute('aria-label', `移除${part.file ? '附件' : '提及'} ${part.file?.name || part.member!.name}`); remove.className = 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-surface-elevated'; remove.onpointerdown = event => event.preventDefault(); remove.onclick = () => onTokenRemove(token); remove.innerHTML = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m18 6-12 12M6 6l12 12"/></svg>'; chip.append(remove); }
        node.append(chip);
      } else {
        const lines = part.text.split('\n');
        lines.forEach((line, index) => { if (line) node.append(document.createTextNode(line)); if (index < lines.length - 1) node.append(document.createElement('br')); });
      }
    }
    if (lastSelection.current !== null && document.activeElement === node) { setChatEditorCaret(node, lastSelection.current); lastSelection.current = null; }
  }, [input, value, files, mentions, readOnly, onTokenRemove]);
  return <div ref={input} role="textbox" aria-multiline="true" aria-label={label} aria-readonly={readOnly || undefined} aria-hidden={masked || undefined} tabIndex={readOnly ? 0 : undefined}
    contentEditable={!readOnly} suppressContentEditableWarning spellCheck="true" data-placeholder={placeholder}
    className="session-chat-input session-chat-rich-editor col-start-1 row-start-1 block w-full min-w-0 self-stretch overflow-y-auto break-words bg-transparent px-1 py-2 text-base leading-7 outline-none"
    onFocus={onFocus} onInput={event => { const value = readChatEditor(event.currentTarget); lastSelection.current = value.end; onInput(value.text, value.start, value.end); }}
    onKeyDown={onKeyDown} onPaste={onPaste} onClick={event => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-chat-inline-token]') : null;
      if (!target) return;
      const before = document.createRange(); before.selectNodeContents(event.currentTarget); before.setEndBefore(target);
      const start = serializeChildren(before.cloneContents()).length;
      setChatEditorCaret(event.currentTarget, start + (target.dataset.chatInlineToken?.length ?? 0));
    }}
    onBeforeInput={event => {
      const inputType = (event.nativeEvent as InputEvent).inputType;
      if (inputType !== 'insertParagraph' && inputType !== 'insertLineBreak') return;
      event.preventDefault();
      const point = readChatEditor(event.currentTarget), next = `${value.slice(0, point.start)}\n${value.slice(point.end)}`;
      onInput(next, point.start + 1, point.start + 1);
    }} />;
}
