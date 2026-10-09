import { collaborationPaneId, useCollaborationPanelDock } from '../stores/useCollaborationPanelDock';
type InputReceiver = (text: string) => void;
const receivers = new Map<string, { receive: InputReceiver; requiresFocus: boolean; paneKey: string }>();
let activeKey: string | undefined;
function activeReceiver() {
  const pane = useCollaborationPanelDock.getState().activePaneId;
  const entry = receivers.get(activeKey ?? '');
  if (entry?.requiresFocus && pane === collaborationPaneId(entry.paneKey)) return entry.receive;
  for (const candidate of receivers.values()) {
    if (candidate.requiresFocus && pane === collaborationPaneId(candidate.paneKey)) return candidate.receive;
  }
  return entry && !entry.requiresFocus ? entry.receive : undefined;
}
export function focusCollaborationInput(key: string): void {
  const entry = receivers.get(key);
  if (!entry) return;
  activeKey = key;
  useCollaborationPanelDock.getState().setActivePane(entry.requiresFocus ? collaborationPaneId(entry.paneKey) : null);
}

/** Only explicit insert/paste actions use this target; terminal typing stays local. */
export function routeCollaborationInput(text: string): boolean {
  const receiver = activeReceiver();
  if (!receiver || !text) return false;
  receiver(text);
  return true;
}

export function registerCollaborationInput(next: InputReceiver, key = 'default', requiresFocus = false, paneKey = key): () => void {
  receivers.set(key, { receive: next, requiresFocus, paneKey });
  if (!requiresFocus) focusCollaborationInput(key);
  const insert = (event: Event) => {
    const { text, nonce } = (event as CustomEvent<{ text?: string; nonce?: string }>).detail ?? {};
    if (!text || activeReceiver() !== next) return;
    next(text);
    event.stopImmediatePropagation();
    if (nonce) window.dispatchEvent(new CustomEvent('termdock-insert-reference-ack', { detail: { nonce, ok: true } }));
  };
  window.addEventListener('termdock-insert-reference', insert, true);
  return () => {
    if (receivers.get(key)?.receive === next) {
      receivers.delete(key);
      if (activeKey === key) activeKey = [...receivers.keys()].at(-1);
    }
    window.removeEventListener('termdock-insert-reference', insert, true);
  };
}
