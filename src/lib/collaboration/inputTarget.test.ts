// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { registerCollaborationInput, routeCollaborationInput } from './inputTarget';
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
