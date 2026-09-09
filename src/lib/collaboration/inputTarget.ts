type InputReceiver = (text: string) => void;
let receiver: InputReceiver | null = null;

/** Only explicit insert/paste actions use this target; terminal typing stays local. */
export function routeCollaborationInput(text: string): boolean {
  if (!receiver || !text) return false;
  receiver(text);
  return true;
}

export function registerCollaborationInput(next: InputReceiver): () => void {
  receiver = next;
  const insert = (event: Event) => {
    const { text, nonce } = (event as CustomEvent<{ text?: string; nonce?: string }>).detail ?? {};
    if (!text || receiver !== next) return;
    next(text);
    event.stopImmediatePropagation();
    if (nonce) window.dispatchEvent(new CustomEvent('termdock-insert-reference-ack', { detail: { nonce, ok: true } }));
  };
  window.addEventListener('termdock-insert-reference', insert, true);
  return () => {
    if (receiver === next) receiver = null;
    window.removeEventListener('termdock-insert-reference', insert, true);
  };
}
