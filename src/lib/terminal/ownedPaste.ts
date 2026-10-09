import { getActiveKeyboardLayer, isKeyboardLayerSource } from '../hooks/useKeyboardLayer';
import { buildBracketedPastePayload } from './bracketedPaste';

export interface OwnedTerminalPaste { readonly nonce: string }
interface Request {
  source: HTMLElement;
  layer: ReturnType<typeof getActiveKeyboardLayer>;
  consumed?: boolean;
  sessionId: string;
  text: string;
  token: OwnedTerminalPaste;
}
const requests = new Map<string, Request>();

/** A short-lived, one-use intent from the visible action, bound to text and target. */
export function createOwnedTerminalPasteRequest(source: HTMLElement, sessionId: string, text: string) {
  if (!text || !sessionId || !isKeyboardLayerSource(source)) return null;
  const nonce = `owned-paste-${crypto.randomUUID()}`;
  requests.set(nonce, { source, layer: getActiveKeyboardLayer(), sessionId, text, token: { nonce } });
  return { nonce, text, sessionId, paste: true, submitAfterPaste: false, focus: false, ownedPaste: true } as const;
}

export function releaseOwnedTerminalPasteRequest(nonce: string): void { requests.delete(nonce); }

function current(request: Request): boolean {
  return request.layer === getActiveKeyboardLayer() && isKeyboardLayerSource(request.source);
}

/** Flags/targeting alone never grant permission to cross a keyboard layer. */
export function authorizeOwnedTerminalPaste(detail: {
  nonce?: string; sessionId?: string; text?: string; paste?: boolean; submitAfterPaste?: boolean; ownedPaste?: boolean;
}, sessionId: string): OwnedTerminalPaste | null {
  const request = detail.nonce ? requests.get(detail.nonce) : undefined;
  return request && current(request) && detail.ownedPaste === true && detail.paste === true
    && detail.submitAfterPaste === false && request.sessionId === sessionId && detail.sessionId === sessionId
    && detail.text === request.text ? request.token : null;
}

export function consumeOwnedTerminalPaste(token: OwnedTerminalPaste, sessionId: string, payload: string): boolean {
  const request = requests.get(token.nonce);
  if (!request || request.token !== token) return false;
  if (request.consumed) return false;
  request.consumed = true;
  return current(request) && request.sessionId === sessionId
    && payload === buildBracketedPastePayload(request.text, false);
}

/** ACK, timeout, layer closure and unmount revoke even an already consumed intent. */
export function isOwnedTerminalPasteCurrent(token: OwnedTerminalPaste, sessionId: string): boolean {
  const request = requests.get(token.nonce);
  return !!request && request.token === token && request.sessionId === sessionId && current(request);
}
