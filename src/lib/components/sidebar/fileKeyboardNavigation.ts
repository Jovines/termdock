import type { KeyboardEvent } from 'react';
import { isKeyboardLayerSource } from '../../hooks/useKeyboardLayer';

/** Navigate the rendered tree so sorting, filtering and collapsed folders agree with the UI. */
export function navigateFileWithArrowKey(
  event: KeyboardEvent<HTMLElement>,
  tree: HTMLElement | null,
  selectedPath: string | null,
  onSelect: (path: string) => void,
): void {
  if (!tree || event.defaultPrevented || event.nativeEvent.isComposing
    || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || !event.currentTarget.contains(target)
    || !isKeyboardLayerSource(target)) return;
  // File rows are buttons too; their nested actions, editors and menus keep their own keys.
  const control = target.closest('button, a, input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="textbox"], [role="menu"], [role="listbox"], [role="slider"], [role="dialog"]');
  if (control && !control.matches('[data-file-tree-path]')) return;
  if (window.getSelection()?.isCollapsed === false) return;

  const rows = Array.from(tree.querySelectorAll<HTMLElement>('[data-file-tree-path]'))
    .filter(row => !row.closest('[hidden], [inert], [aria-hidden="true"]'));
  if (!rows.some(row => row.dataset.fileTreeType === 'file')) return;
  const focusedRow = target.closest('[data-file-tree-path]');
  const current = rows.findIndex(row => focusedRow ? row === focusedRow : row.dataset.fileTreePath === selectedPath);
  const step = event.key === 'ArrowDown' ? 1 : -1;
  let index = current < 0 ? (step === 1 ? 0 : rows.length - 1) : current + step;
  event.preventDefault();
  event.stopPropagation();
  for (; index >= 0 && index < rows.length; index += step) {
    const next = rows[index];
    if (next.dataset.fileTreeType !== 'file') continue;
    onSelect(next.dataset.fileTreePath!);
    if (tree.contains(target)) next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
}
