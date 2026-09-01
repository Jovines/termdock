const SOFT_KEYBOARD_EDITABLE_SELECTOR =
  'input:not([type="hidden"]), textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * Dismiss the mobile soft keyboard without moving focus for unrelated controls.
 * This is intentionally called only after an edge drag commits to opening a
 * sidebar; button/shortcut/programmatic opens keep their existing focus rules.
 */
export function dismissSoftKeyboardForEdgeOpen(): void {
  if (typeof document === 'undefined') return;
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return;
  if (!activeElement.matches(SOFT_KEYBOARD_EDITABLE_SELECTOR)) return;
  activeElement.blur();
}
