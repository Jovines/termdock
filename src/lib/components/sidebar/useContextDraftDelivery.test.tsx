// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useContextDraftDelivery } from './useContextDraftDelivery';
import { terminalSequencePayload } from '../../terminal/sequencePayload';
import { ContextDraftDock } from './ContextDraftDock';

vi.mock('../../terminal/api', () => ({ getSettings: vi.fn().mockResolvedValue({}), updateSettings: vi.fn().mockResolvedValue({}) }));
const labels = { title: 'Draft', hint: '', placeholder: '', collapse: 'Collapse', expand: 'Expand', disable: 'Disable', clear: 'Clear', insert: 'Insert', insertAndSend: 'Insert & send', inserted: 'Inserted', sent: 'Sent', pending: 'Waiting', send: 'Send draft', appended: 'Added', resize: 'Resize', autoCollapseAfterSend: 'Auto collapse', characterCount: (count: number) => `${count}` };
const listeners: EventListener[] = [];
function receive(handler: (detail: any) => void) {
  const listener: EventListener = event => handler((event as CustomEvent).detail);
  listeners.push(listener);
  window.addEventListener('termdock-insert-reference', listener);
}
function ack(nonce: string, ok: boolean) { window.dispatchEvent(new CustomEvent('termdock-insert-reference-ack', { detail: { nonce, ok } })); }
afterEach(() => { cleanup(); listeners.splice(0).forEach(listener => window.removeEventListener('termdock-insert-reference', listener)); vi.useRealTimers(); });

describe('draft delivery through the component, nonce ACK and real sequence encoder', () => {
  it.each(['first\nsecond', 'first\rsecond', 'first\r\nsecond\n', 'first\n', 'first\n\x1b[201~second'])('inserts %j entirely inside bracketed paste, without a trailing submit', async draft => {
    let encoded = ''; let target = '';
    receive(detail => { target = detail.sessionId; encoded = terminalSequencePayload(detail.text, detail); ack(detail.nonce, true); });
    const accepted = vi.fn();
    const { result } = renderHook(() => useContextDraftDelivery({ text: draft, sessionId: 'own-shell', active: true, onAccepted: accepted, onRejected: vi.fn() }));
    await act(async () => { expect(await result.current(false)).toBe(true); });
    expect(target).toBe('own-shell');
    expect(encoded).toMatch(/^\x1b\[200~/);
    expect(encoded.endsWith('\x1b[201~')).toBe(true);
    expect(encoded.match(/\x1b\[201~/g)).toHaveLength(1);
    expect(accepted).toHaveBeenCalledOnce();
  });
  it('retains single-line Insert and explicit Send semantics', async () => {
    const encoded: string[] = [];
    receive(detail => { encoded.push(terminalSequencePayload(detail.text, detail)); ack(detail.nonce, true); });
    const { result, rerender } = renderHook(({ text }) => useContextDraftDelivery({ text, sessionId: 'own-shell', active: true, onAccepted: vi.fn(), onRejected: vi.fn() }), { initialProps: { text: 'single' } });
    await act(async () => { await result.current(false); await result.current(true); });
    rerender({ text: 'first\nsecond' });
    await act(async () => { await result.current(true); });
    expect(encoded).toEqual(['single ', 'single\r', '\x1b[200~first\rsecond\x1b[201~\r']);
  });
  it('shows no success label until accepted, rejects without clearing, and suppresses duplicate clicks', async () => {
    let nonce = ''; let calls = 0;
    receive(detail => { nonce = detail.nonce; calls += 1; });
    function Dock() {
      const [text, setText] = useState('safe-draft'); const [error, setError] = useState<string | null>(null);
      const deliver = useContextDraftDelivery({ text, sessionId: 'own-shell', active: true, onAccepted: () => setText(''), onRejected: () => setError('Input rejected — draft kept') });
      return <ContextDraftDock value={text} collapsed={false} autoCollapseAfterSend={false} labels={labels} insertError={error} onChange={setText} onCollapsedChange={vi.fn()} onAutoCollapseAfterSendChange={vi.fn()} onDisable={vi.fn()} onClear={() => setText('')} onInsert={() => deliver(false)} onInsertAndSend={() => deliver(true)} />;
    }
    render(<Dock />);
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    expect(screen.queryByText('Inserted')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send draft' }));
    expect(calls).toBe(1);
    act(() => ack(nonce, false));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Input rejected'));
    expect(screen.queryByText('Inserted')).toBeNull();
    expect(screen.queryByText('Sent')).toBeNull();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('safe-draft');
  });
  it.each([true, false])('late ACK=%s does not clear or relabel a newer edit', async ok => {
    let nonce = ''; receive(detail => { nonce = detail.nonce; });
    const accepted = vi.fn(); const rejected = vi.fn();
    const { result, rerender } = renderHook(({ text, sessionId }) => useContextDraftDelivery({ text, sessionId, active: true, onAccepted: accepted, onRejected: rejected }), { initialProps: { text: 'original', sessionId: 'A' } });
    let pending!: Promise<boolean>; act(() => { pending = result.current(false); });
    rerender({ text: 'newer edit', sessionId: 'A' });
    await act(async () => { ack(nonce, ok); expect(await pending).toBe(false); });
    expect(accepted).not.toHaveBeenCalled(); expect(rejected).not.toHaveBeenCalled();
  });
  it('shows accepted feedback when its parent clears the draft, including effect remounts', async () => {
    receive(detail => ack(detail.nonce, true));
    function Dock() {
      const [text, setText] = useState('safe-draft');
      const deliver = useContextDraftDelivery({ text, sessionId: 'own-shell', active: true, onAccepted: () => setText(''), onRejected: vi.fn() });
      return <ContextDraftDock value={text} collapsed={false} autoCollapseAfterSend={false} labels={labels} onChange={setText} onCollapsedChange={vi.fn()} onAutoCollapseAfterSendChange={vi.fn()} onDisable={vi.fn()} onClear={() => setText('')} onInsert={() => deliver(false)} onInsertAndSend={() => deliver(true)} />;
    }
    render(<StrictMode><Dock /></StrictMode>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Insert' })); });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByText('Inserted')).toBeTruthy();
  });
  it('session switches and timeout do not clear another session draft', async () => {
    vi.useFakeTimers(); let nonce = ''; receive(detail => { nonce = detail.nonce; });
    const accepted = vi.fn(); const rejected = vi.fn();
    const { result, rerender } = renderHook(({ sessionId }) => useContextDraftDelivery({ text: 'safe', sessionId, active: true, onAccepted: accepted, onRejected: rejected }), { initialProps: { sessionId: 'A' } });
    let pending!: Promise<boolean>; act(() => { pending = result.current(false); });
    rerender({ sessionId: 'B' });
    await act(async () => { ack(nonce, true); expect(await pending).toBe(false); });
    expect(accepted).not.toHaveBeenCalled(); expect(rejected).not.toHaveBeenCalled();
    act(() => { pending = result.current(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); expect(await pending).toBe(false); });
    expect(rejected).toHaveBeenCalledOnce();
  });
});
