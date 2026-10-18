import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** Keyboard ownership for this session's close chooser, never a global confirm policy. */
export function SessionCloseConfirmationKeyboard({ sessionId, confirmButton, onConfirm, onCancel, isCurrent }: {
  sessionId: string;
  confirmButton: RefObject<HTMLButtonElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
  isCurrent?: () => boolean;
}) {
  const latest = useRef({ sessionId, onConfirm, onCancel, isCurrent });
  latest.current = { sessionId, onConfirm, onCancel, isCurrent };
  useEffect(() => { confirmButton.current?.focus({ preventScroll: true }); }, [sessionId, confirmButton]);
  useLayoutEffect(() => {
    let consumed = false;
    const handler = (event: KeyboardEvent) => {
      if (latest.current.sessionId !== sessionId) return;
      if (event.key !== 'Escape' && event.key !== 'Enter') return;
      if (event.isComposing || event.keyCode === 229 || (event.key === 'Enter' && (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey))) {
        // This is a focused destructive button, not an IME editable. Prevent
        // its default Enter activation without cancelling text editing elsewhere.
        if (event.key === 'Enter' && event.target instanceof Node && confirmButton.current?.contains(event.target)) event.preventDefault();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      // Keep swallowing repeats until React removes this chooser; never leak
      // the confirming Enter into the newly active terminal.
      if (consumed || event.repeat) return;
      consumed = true;
      if (event.key === 'Escape' || latest.current.isCurrent?.() === false) latest.current.onCancel();
      else latest.current.onConfirm();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [sessionId, confirmButton]);
  return null;
}
