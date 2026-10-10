/** Layout shortcuts yield to form editing and the current temporary task. */
export function canHandleSplitShortcut(event: KeyboardEvent, keyboardLayerOpen: boolean): boolean {
  if (keyboardLayerOpen || event.defaultPrevented || event.isComposing || event.keyCode === 229) return false;
  const target = event.target instanceof Element ? event.target : null;
  const editable = target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
  // The terminal textarea owns raw input; ordinary form textareas do not own
  // workspace navigation. The terminal's own guards remain authoritative.
  return !editable || (editable.matches('textarea[data-terminal-input-anchor], textarea.xterm-helper-textarea')
    && !!editable.closest('.terminal-viewport-container'));
}
