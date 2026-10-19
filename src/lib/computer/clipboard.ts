/** Text clipboard limits are shared by both renderers and the manual panel. */
export const COMPUTER_CLIPBOARD_LIMIT = 1_048_576;

export interface ComputerClipboardOptions {
  paste(text: string, shift: boolean): void;
  receive(text: string): void;
  failed(): void;
}

/** Keep native paste available before a renderer consumes Ctrl/Cmd+V. Reading
 * ClipboardEvent data needs no asynchronous permission prompt or extra shortcut.
 * Clipboard contents belong to this connection, never the application logger. */
export function attachComputerClipboard(viewport: HTMLElement, session: EventTarget, options: ComputerClipboardOptions): () => void {
  const abort = new AbortController();
  let pasteShift = false, copyRequestedAt = -Infinity, active = true;
  const pasteKeys = new Set<string>();
  const keydown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return;
    const key = event.key.toLowerCase();
    if (key === 'v') {
      pasteShift = event.shiftKey; pasteKeys.add(event.code || event.key);
      // Leave the browser default intact so it delivers the actual clipboard.
      event.stopImmediatePropagation();
    } else if (key === 'c' || key === 'x') copyRequestedAt = performance.now();
  };
  const paste = (event: ClipboardEvent) => {
    event.preventDefault(); event.stopImmediatePropagation();
    const clipboard = event.clipboardData;
    if (!clipboard || !Array.from(clipboard.types).includes('text/plain')) { options.failed(); return; }
    const text = clipboard.getData('text/plain');
    if (text.length > COMPUTER_CLIPBOARD_LIMIT) { options.failed(); return; }
    try { options.paste(text, pasteShift); } catch { options.failed(); }
    pasteShift = false;
  };
  const receive = (event: Event) => {
    const text = (event as CustomEvent<{ text: string }>).detail?.text;
    if (typeof text !== 'string' || text.length > COMPUTER_CLIPBOARD_LIMIT) { options.failed(); return; }
    options.receive(text);
    // Only a copy explicitly requested in this desktop may update the system
    // clipboard automatically. Otherwise keep the content in the manual panel.
    if (performance.now() - copyRequestedAt < 2000) {
      copyRequestedAt = -Infinity;
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text).catch(() => { if (active) options.failed(); });
      } else options.failed();
    }
  };
  const capture = { capture: true, signal: abort.signal };
  viewport.addEventListener('keydown', keydown, capture);
  viewport.addEventListener('keyup', event => {
    if (pasteKeys.delete(event.code || event.key)) event.stopImmediatePropagation();
  }, capture);
  viewport.addEventListener('paste', paste, capture);
  session.addEventListener('clipboard', receive, { signal: abort.signal });
  session.addEventListener('clipboarderror', options.failed, { signal: abort.signal });
  window.addEventListener('blur', () => { pasteKeys.clear(); pasteShift = false; copyRequestedAt = -Infinity; }, { signal: abort.signal });
  return () => { active = false; abort.abort(); };
}
