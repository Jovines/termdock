import { useEffect } from 'react';
import { setTerminalOutputSubscription } from '../terminal/api';

export const BACKGROUND_OUTPUT_GRACE_MS = 15_000;

/** A brief app switch must not detach tmux and force a full-screen replay.
 * Unseen slides still detach immediately. Long background stays retain the
 * existing output budget and reconnect/replay recovery mechanisms.
 */
export function useTerminalOutputSubscription(
  sessionId: string | null,
  layoutVisible: boolean,
  documentVisible: boolean,
  streamReady: boolean,
): void {
  useEffect(() => {
    if (!sessionId) return;
    if (!layoutVisible || documentVisible) {
      setTerminalOutputSubscription(sessionId, layoutVisible);
      return;
    }
    const timer = window.setTimeout(() => {
      // iOS can defer this timer until foreground, before React has committed
      // visibility state. Never detach a page that has already returned.
      if (document.hidden) setTerminalOutputSubscription(sessionId, false);
    }, BACKGROUND_OUTPUT_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [sessionId, layoutVisible, documentVisible, streamReady]);
}
