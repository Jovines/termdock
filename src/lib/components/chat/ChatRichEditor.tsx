import { useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent, type RefObject } from 'react';
import { chatAttachmentKind, type ChatAttachment, type ChatMention } from './chatComposerContent';
import { useChatAttachmentPreview } from './useChatAttachmentPreview';
import { chatInlineParts, chatInlineLabel, chatInlineTitle, chatInlineTokenClass, chatInlineTokenTitleClass } from './ChatInlineContent';

function isBlock(node: Node): boolean { return node instanceof HTMLElement && (node.tagName === 'DIV' || node.tagName === 'P'); }
function serializeChildren(parent: Node, editorRoot = false): string {
  const onlyChild = parent.childNodes.length === 1 ? parent.firstChild : null;
  // A lone BR is the browser's empty caret placeholder. Real trailing
  // newlines get a separate, non-text caret placeholder when rendered.
  if (editorRoot && onlyChild instanceof HTMLElement && onlyChild.tagName === 'BR') return '';
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
  const text = serializeChildren(node, true);
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
  const { onPreview, preview } = useChatAttachmentPreview(files);
  const lastSelection = useRef<number | null>(null);
  const deleteInlineAtCaret = (backward: boolean) => {
    const node = input.current;
    if (readOnly || !node) return false;
    const point = readChatEditor(node);
    if (point.start !== point.end) return false;
    let start = 0;
    for (const part of chatInlineParts(point.text, files, mentions)) {
      const end = start + part.text.length;
      // Uploads insert a single space for continued typing. Consume that
      // separator with the chip instead of letting the browser jump over it.
      const afterSeparator = point.start === end + 1 && /[ \u00a0]/.test(point.text[end] ?? '');
      const hit = backward ? point.start > start && (point.start <= end || afterSeparator) : point.start >= start && point.start < end;
      if (part.token && hit) {
        const until = backward && afterSeparator ? point.start : end;
        const next = point.text.slice(0, start) + point.text.slice(until);
        lastSelection.current = start;
        onInput(next, start, start);
        return true;
      }
      start = end;
    }
    return false;
  };
  // Mobile keyboards may only dispatch beforeinput, without a keydown.
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    const beforeInput = (event: InputEvent) => {
      if (readOnly || event.isComposing) return;
      if ((event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward') && deleteInlineAtCaret(event.inputType === 'deleteContentBackward')) event.preventDefault();
      if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
        event.preventDefault();
        const point = readChatEditor(node), next = `${point.text.slice(0, point.start)}\n${point.text.slice(point.end)}`;
        lastSelection.current = point.start + 1;
        onInput(next, point.start + 1, point.start + 1);
      }
    };
    node.addEventListener('beforeinput', beforeInput);
    return () => node.removeEventListener('beforeinput', beforeInput);
  });
  useLayoutEffect(() => {
    const node = input.current; if (!node) return;
    const desired = chatInlineParts(value, files, mentions);
    const hasExpectedChips = desired.filter(part => part.file || part.member).every(part => {
      const chip = [...node.querySelectorAll<HTMLElement>('[data-chat-inline-token]')].find(chip => chip.dataset.chatInlineToken === part.token);
      return chip && !!chip.dataset.chatMediaPreview === !!(part.file && chatAttachmentKind(part.file) !== '文件' && onPreview);
    });
    if (readChatEditor(node).text === value && hasExpectedChips) return;
    node.replaceChildren();
    for (const part of desired) {
      if (part.file || part.member) {
        const token = part.token!, kind = part.file ? chatAttachmentKind(part.file) : undefined;
        const label = chatInlineLabel(part);
        const chip = document.createElement('span'); chip.contentEditable = 'false'; chip.dataset.chatInlineToken = token;
        chip.dataset.chatInlineKind = part.file ? 'attachment' : 'mention'; chip.setAttribute('role', 'group');
        chip.setAttribute('aria-label', part.file ? `附件 ${label}` : `提及 ${label}`);
        chip.className = chatInlineTokenClass;
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('width', '13'); icon.setAttribute('height', '13'); icon.setAttribute('class', 'shrink-0'); icon.innerHTML = kind === '图片' ? '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>' : kind === '视频' ? '<path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2"/>' : '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>'; icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor'); icon.setAttribute('stroke-width', '2'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round'); chip.append(icon);
        const title = document.createElement('span'); title.className = chatInlineTokenTitleClass; title.textContent = chatInlineTitle(part); title.title = label; chip.append(title);
        if ((kind === '图片' || kind === '视频') && onPreview) {
          chip.dataset.chatMediaPreview = 'true';
          const open = document.createElement('button'); open.type = 'button';
          open.setAttribute('aria-label', `预览${kind} ${part.file!.name}`); open.title = label;
          open.className = 'inline-flex min-w-0 items-center gap-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
          open.onpointerdown = event => event.preventDefault();
          open.onclick = event => { event.stopPropagation(); onPreview(part.file!); };
          open.append(icon, title); chip.append(open);
        }
        if (!readOnly) { const remove = document.createElement('button'); remove.type = 'button'; remove.setAttribute('aria-label', `移除${part.file ? '附件' : '提及'} ${part.file?.name || part.member!.name}`); remove.className = 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-surface-elevated'; remove.onpointerdown = event => event.preventDefault(); remove.onclick = () => onTokenRemove(token); remove.innerHTML = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m18 6-12 12M6 6l12 12"/></svg>'; chip.append(remove); }
        node.append(chip);
      } else {
        const lines = part.text.split('\n');
        lines.forEach((line, index) => {
          if (line) node.append(document.createTextNode(line));
          if (index < lines.length - 1) node.append(document.createElement('br'));
        });
      }
    }
    if (value.endsWith('\n')) { const placeholder = document.createElement('br'); placeholder.dataset.chatPlaceholder = 'true'; node.append(placeholder); }
    if (lastSelection.current !== null && document.activeElement === node) { setChatEditorCaret(node, lastSelection.current); lastSelection.current = null; }
  }, [input, value, files, mentions, readOnly, onTokenRemove, onPreview]);
  return <><div ref={input} role="textbox" aria-multiline="true" aria-label={label} aria-readonly={readOnly || undefined} aria-hidden={masked || undefined} tabIndex={readOnly ? 0 : undefined}
    contentEditable={!readOnly} suppressContentEditableWarning spellCheck="true" data-placeholder={placeholder}
    className="session-chat-input session-chat-rich-editor col-start-1 row-start-1 block w-full min-w-0 self-stretch overflow-y-auto break-words bg-transparent px-1 py-2 text-base leading-7 outline-none"
    onFocus={onFocus} onInput={event => {
      const node = event.currentTarget, value = readChatEditor(node);
      if (!value.text && node.childNodes.length && !(event.nativeEvent as InputEvent).isComposing) {
        node.replaceChildren();
        if (document.activeElement === node) setChatEditorCaret(node, 0);
      }
      lastSelection.current = value.end; onInput(value.text, value.start, value.end);
    }}
    onKeyDown={event => {
      if (event.target instanceof Element && event.target.closest('button')) { event.stopPropagation(); return; }
      if (!event.nativeEvent.isComposing && (event.key === 'Backspace' || event.key === 'Delete') && deleteInlineAtCaret(event.key === 'Backspace')) {
        event.preventDefault(); event.stopPropagation(); return;
      }
      onKeyDown(event);
    }} onPaste={onPaste} onClick={event => {
      if (event.target instanceof Element && event.target.closest('button')) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-chat-inline-token]') : null;
      if (!target) return;
      const before = document.createRange(); before.selectNodeContents(event.currentTarget); before.setEndBefore(target);
      const start = serializeChildren(before.cloneContents()).length;
      setChatEditorCaret(event.currentTarget, start + (target.dataset.chatInlineToken?.length ?? 0));
    }}
    onBeforeInput={event => {
      const native = event.nativeEvent as InputEvent, inputType = native.inputType;
      if (native.isComposing) return;
      if (inputType !== 'insertParagraph' && inputType !== 'insertLineBreak') return;
      event.preventDefault();
      const point = readChatEditor(event.currentTarget), next = `${value.slice(0, point.start)}\n${value.slice(point.end)}`;
      onInput(next, point.start + 1, point.start + 1);
    }} />{preview}</>;
}
