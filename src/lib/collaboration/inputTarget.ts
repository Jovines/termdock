type InputReceiver = (text: string) => void;
const receivers = new Map<string, InputReceiver>();
let activeKey: string | undefined;
function activeReceiver() { return receivers.get(activeKey ?? ''); }
export function focusCollaborationInput(key: string): void {
  if (receivers.has(key)) activeKey = key;
}

/** Only explicit insert/paste actions use this target; terminal typing stays local. */
export function routeCollaborationInput(text: string): boolean {
  const receiver = activeReceiver();
  if (!receiver || !text) return false;
  receiver(text);
  return true;
}

export function registerCollaborationInput(next: InputReceiver, key = 'default'): () => void {
  receivers.set(key, next);
  activeKey = key;
  const insert = (event: Event) => {
    const { text, nonce } = (event as CustomEvent<{ text?: string; nonce?: string }>).detail ?? {};
    if (!text || activeReceiver() !== next) return;
    next(text);
    event.stopImmediatePropagation();
    if (nonce) window.dispatchEvent(new CustomEvent('termdock-insert-reference-ack', { detail: { nonce, ok: true } }));
  };
  window.addEventListener('termdock-insert-reference', insert, true);
  return () => {
    if (receivers.get(key) === next) {
      receivers.delete(key);
      if (activeKey === key) activeKey = [...receivers.keys()].at(-1);
    }
    window.removeEventListener('termdock-insert-reference', insert, true);
  };
}
