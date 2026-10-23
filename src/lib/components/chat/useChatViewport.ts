import { useLayoutEffect, useState } from 'react';
import { VIEWPORT_LAYOUT_CHANGE_EVENT } from '../../hooks/useViewportHeight';
const owners = new Set<symbol>();
/** Lease the chat layout; the application's viewport controller owns all geometry. */
export function useChatViewport(active: boolean): boolean {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useLayoutEffect(() => {
    if (!active) { setKeyboardOpen(false); return; }
    const owner = Symbol('chat-viewport'); owners.add(owner);
    const root = document.documentElement;
    const sync = () => {
      const open = Number.parseFloat(root.style.getPropertyValue('--kb-height')) >= 80;
      root.dataset.termdockChatViewport = 'true';
      root.dataset.termdockChatKeyboard = String(open);
      setKeyboardOpen(previous => previous === open ? previous : open);
    };
    sync();
    document.addEventListener(VIEWPORT_LAYOUT_CHANGE_EVENT, sync);
    document.addEventListener('termdock:viewport-keyboard-change', sync);
    return () => {
      document.removeEventListener(VIEWPORT_LAYOUT_CHANGE_EVENT, sync);
      document.removeEventListener('termdock:viewport-keyboard-change', sync);
      owners.delete(owner);
      if (!owners.size) { delete root.dataset.termdockChatViewport; delete root.dataset.termdockChatKeyboard; }
    };
  }, [active]);
  return keyboardOpen;
}
