import { useEffect } from 'react';
import { setTerminalOutputSubscription } from '../terminal/api';

/** Mounted terminals keep their live stream across session switches. Detaching
 * an offscreen tmux client forces a reset/full-screen replay on its next swipe.
 * Mobile viewport retention already bounds the number of mounted terminals;
 * unmount closes their streams. Hidden pages retain the same bounded delivery
 * stream; server flow control disconnects an observer only if it falls behind.
 */
export function useTerminalOutputSubscription(
  sessionId: string | null,
  _documentVisible: boolean,
  streamReady: boolean,
): void {
  useEffect(() => {
    if (!sessionId) return;
    setTerminalOutputSubscription(sessionId, true);
  }, [sessionId, streamReady]);
}
