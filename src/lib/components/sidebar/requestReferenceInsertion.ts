import { createOwnedTerminalPasteRequest, releaseOwnedTerminalPasteRequest } from '../../terminal/ownedPaste';
import type { TerminalSequenceOptions } from '../../terminal/sequencePayload';

/** An ACK confirms local input acceptance, not execution or an Agent reply. */
export function requestReferenceInsertion(text: string, sessionId: string | null, isCurrent: () => boolean, source?: HTMLElement, options?: TerminalSequenceOptions): Promise<boolean> {
  if (!text || !sessionId || !isCurrent()) return Promise.resolve(false);
  const owned = source ? createOwnedTerminalPasteRequest(source, sessionId, text) : null;
  if (source && !owned) return Promise.resolve(false);
  const nonce = owned?.nonce ?? `reference-${crypto.randomUUID()}`;
  return new Promise<boolean>((resolve) => {
    let finished = false;
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      window.removeEventListener('termdock-insert-reference-ack', onAck);
      if (owned) releaseOwnedTerminalPasteRequest(nonce);
      resolve(ok && isCurrent());
    };
    const onAck = (event: Event) => {
      const detail = (event as CustomEvent<{ nonce?: string; ok?: boolean }>).detail;
      if (detail?.nonce === nonce) finish(detail.ok === true);
    };
    const timer = window.setTimeout(() => finish(false), 1500);
    window.addEventListener('termdock-insert-reference-ack', onAck);
    window.dispatchEvent(new CustomEvent('termdock-insert-reference', {
      detail: owned ?? { text, sessionId, nonce, focus: false, paste: true, submitAfterPaste: false, ...options },
    }));
  });
}
