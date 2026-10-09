// @vitest-environment jsdom
import { useRef } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useKeyboardLayer } from '../hooks/useKeyboardLayer';
import { authorizeOwnedTerminalPaste, consumeOwnedTerminalPaste, createOwnedTerminalPasteRequest,
  isOwnedTerminalPasteCurrent, releaseOwnedTerminalPasteRequest } from './ownedPaste';
import { terminalSequencePayload } from './sequencePayload';
import { requestReferenceInsertion } from '../components/sidebar/requestReferenceInsertion';
const pending = new Set<string>();
afterEach(() => { cleanup(); pending.forEach(releaseOwnedTerminalPasteRequest); pending.clear(); vi.useRealTimers(); });
function Layer({ open = true, child = false }: { open?: boolean; child?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useKeyboardLayer(ref, open, () => {});
  return <div ref={ref}><button>Parent action</button>{child && <Child />}</div>;
}
function Child() { const ref = useRef<HTMLDivElement>(null); useKeyboardLayer(ref, true, () => {}); return <div ref={ref}><button>Child action</button></div>; }
function issue(text = 'first\nsecond\r') {
  const request = createOwnedTerminalPasteRequest(screen.getByRole('button', { name: 'Parent action' }), 'alpha', text)!;
  expect(request).not.toBeNull(); pending.add(request.nonce); return request;
}
it('binds exact target and raw text, encodes every line in one block without submitting, and rejects replay', () => {
  render(<Layer />); const request = issue();
  expect(authorizeOwnedTerminalPaste({ ...request, text: 'other' }, 'alpha')).toBeNull();
  expect(authorizeOwnedTerminalPaste({ ...request, sessionId: 'beta' }, 'beta')).toBeNull();
  expect(authorizeOwnedTerminalPaste({ ...request, submitAfterPaste: true }, 'alpha')).toBeNull();
  expect(authorizeOwnedTerminalPaste({ ...request, paste: false }, 'alpha')).toBeNull();
  const token = authorizeOwnedTerminalPaste(request, 'alpha')!;
  const payload = terminalSequencePayload(request.text, { ...request, ownedPaste: token });
  expect(payload).toBe('\x1b[200~first\rsecond\r\x1b[201~');
  expect(consumeOwnedTerminalPaste(token, 'alpha', payload)).toBe(true);
  expect(consumeOwnedTerminalPaste(token, 'alpha', payload)).toBe(false);
  expect(isOwnedTerminalPasteCurrent(token, 'alpha')).toBe(true);
  releaseOwnedTerminalPasteRequest(request.nonce);
  expect(isOwnedTerminalPasteCurrent(token, 'alpha')).toBe(false);
});
it.each(['text', 'session', 'forged token'])('rejects %s at the final input boundary', failure => {
  render(<Layer />); const request = issue(); const token = authorizeOwnedTerminalPaste(request, 'alpha')!;
  expect(consumeOwnedTerminalPaste(failure === 'forged token' ? { ...token } : token,
    failure === 'session' ? 'beta' : 'alpha', failure === 'text' ? 'x' : terminalSequencePayload(request.text, { ownedPaste: token }))).toBe(false);
});
it('cannot mint input permission from the background or a parent covered by a child layer', () => {
  const view = render(<><button>Background action</button><Layer child /></>);
  for (const name of ['Background action', 'Parent action']) {
    expect(createOwnedTerminalPasteRequest(screen.getByRole('button', { name }), 'alpha', 'x')).toBeNull();
  }
  const request = createOwnedTerminalPasteRequest(screen.getByRole('button', { name: 'Child action' }), 'alpha', 'x')!;
  pending.add(request.nonce); expect(authorizeOwnedTerminalPaste(request, 'alpha')).not.toBeNull();
  view.unmount(); expect(authorizeOwnedTerminalPaste(request, 'alpha')).toBeNull();
});
it('revokes a lease when the same DOM layer closes and registers again', () => {
  const view = render(<Layer />); const request = issue(); const source = screen.getByRole('button', { name: 'Parent action' });
  const token = authorizeOwnedTerminalPaste(request, 'alpha')!;
  const payload = terminalSequencePayload(request.text, { ownedPaste: token });
  expect(consumeOwnedTerminalPaste(token, 'alpha', payload)).toBe(true);
  view.rerender(<Layer open={false} />); view.rerender(<Layer />);
  expect(screen.getByRole('button', { name: 'Parent action' })).toBe(source);
  expect(isOwnedTerminalPasteCurrent(token, 'alpha')).toBe(false);
  expect(authorizeOwnedTerminalPaste(request, 'alpha')).toBeNull();
});
it('escapes embedded terminal controls and never puts a trailing Enter outside the owned paste', () => {
  render(<Layer />); const request = issue('one\n\x1b[201~\rtwo\r'); const token = authorizeOwnedTerminalPaste(request, 'alpha')!;
  expect(terminalSequencePayload(request.text, { ownedPaste: token, submitAfterPaste: true })).toBe('\x1b[200~one\r␛[201~\rtwo\r\x1b[201~');
  expect(terminalSequencePayload('plain')).toBe('plain');
  expect(terminalSequencePayload('line\r', { paste: true, submitAfterPaste: false })).toBe('\x1b[200~line\r\x1b[201~');
  expect(terminalSequencePayload('line\r', { paste: true, submitAfterPaste: true })).toBe('\x1b[200~line\x1b[201~\r');
});
it('times out without a controller, revokes the intent, and ignores a late ACK', async () => {
  vi.useFakeTimers(); render(<Layer />);
  let detail: ReturnType<typeof createOwnedTerminalPasteRequest> = null;
  const listener = (event: Event) => { detail = (event as CustomEvent).detail; };
  window.addEventListener('termdock-insert-reference', listener);
  try {
    const result = requestReferenceInsertion('one\ntwo', 'alpha', () => true, screen.getByRole('button', { name: 'Parent action' }));
    expect(authorizeOwnedTerminalPaste(detail!, 'alpha')).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1500));
    await expect(result).resolves.toBe(false);
    expect(authorizeOwnedTerminalPaste(detail!, 'alpha')).toBeNull();
    window.dispatchEvent(new CustomEvent('termdock-insert-reference-ack', { detail: { nonce: detail!.nonce, ok: true } }));
    await expect(result).resolves.toBe(false);
  } finally { window.removeEventListener('termdock-insert-reference', listener); }
});

it('never downgrades a detached explicit source to an unowned background request', async () => {
  const source = document.createElement('button');
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  await expect(requestReferenceInsertion('text', 'alpha', () => true, source)).resolves.toBe(false);
  expect(dispatch).not.toHaveBeenCalled();
  dispatch.mockRestore();
});
