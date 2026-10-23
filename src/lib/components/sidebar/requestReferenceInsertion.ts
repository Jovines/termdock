import { getActiveKeyboardLayer, isKeyboardLayerSource } from '../../hooks/useKeyboardLayer';
import { currentSecureClient, savedConnection } from '../../federation/browserIntegration';
import { createOwnedTerminalPasteRequest, releaseOwnedTerminalPasteRequest } from '../../terminal/ownedPaste';
import type { TerminalSequenceOptions } from '../../terminal/sequencePayload';

/** Freeze the visible action and service before any capture, save or upload awaits. */
export function captureReferenceInsertionScope(source?: HTMLElement): () => boolean {
  const layer = getActiveKeyboardLayer();
  const connection = savedConnection();
  const client = currentSecureClient();
  return () => {
    const selected = savedConnection();
    return getActiveKeyboardLayer() === layer && (!source || isKeyboardLayerSource(source))
      && selected?.url === connection?.url && selected?.targetPeerId === connection?.targetPeerId
      && currentSecureClient() === client && !client?.closed;
  };
}

/** An ACK confirms local input acceptance, not execution or an Agent reply. */
export function requestReferenceInsertion(text: string, sessionId: string | null, isCurrent: () => boolean, source?: HTMLElement, options?: TerminalSequenceOptions & { focus?: boolean }): Promise<boolean> {
  if (!text || !sessionId || !isCurrent()) return Promise.resolve(false);
  const owned = source ? createOwnedTerminalPasteRequest(source, sessionId, text, options?.submitAfterPaste === true) : null;
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
      detail: owned ? { ...owned, focus: options?.focus ?? owned.focus } : { text, sessionId, nonce, focus: false, paste: true, submitAfterPaste: false, ...options },
    }));
  });
}
