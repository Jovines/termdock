// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { focusCollaborationInput, registerCollaborationInput, routeCollaborationInput } from './inputTarget';
import { subscribeNativeFileDrops, type NativeFileDropPayload, type TermdockDesktopBridge } from '../desktop/nativeBridge';

describe('collaboration input priority', () => {
  it('routes native dropped paths once across split terminals, and restores terminal delivery on close', () => {
    let deliver!: (payload: NativeFileDropPayload) => void;
    window.termdockDesktop = { onNativeFileDrop: callback => { deliver = callback; } } as TermdockDesktopBridge;
    const firstTerminal = vi.fn(), secondTerminal = vi.fn(), draft = vi.fn();
    const firstOff = subscribeNativeFileDrops(firstTerminal);
    const secondOff = subscribeNativeFileDrops(secondTerminal);
    const close = registerCollaborationInput(draft);
    deliver({ sessionKey: 'one', paths: ['/repo/file with spaces.md', '/repo/b.txt'] });
    expect(draft).toHaveBeenCalledTimes(1);
    expect(draft.mock.calls[0][0]).toContain('file');
    expect(draft.mock.calls[0][0]).toContain('/repo/b.txt');
    expect(firstTerminal).not.toHaveBeenCalled();
    expect(secondTerminal).not.toHaveBeenCalled();
    close();
    expect(routeCollaborationInput('ordinary paste')).toBe(false);
    deliver({ sessionKey: 'one', paths: ['/repo/c.txt'] });
    expect(firstTerminal).toHaveBeenCalledTimes(1);
    firstOff(); secondOff(); delete window.termdockDesktop;
  });
});

it('routes references to the focused group and preserves another receiver when one closes', () => {
  const a = vi.fn(), b = vi.fn();
  const closeA = registerCollaborationInput(a, 'a');
  const closeB = registerCollaborationInput(b, 'b');
  focusCollaborationInput('a');
  routeCollaborationInput('for A');
  expect(a).toHaveBeenCalledWith('for A');
  expect(b).not.toHaveBeenCalled();
  closeA();
  routeCollaborationInput('for B');
  expect(b).toHaveBeenCalledWith('for B');
  closeB();
  expect(routeCollaborationInput('closed')).toBe(false);
});
