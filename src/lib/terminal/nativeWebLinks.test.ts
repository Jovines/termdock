import { describe, expect, it, vi } from 'vitest';
import { createNativeWebLinkHandler } from './nativeWebLinks';

describe('native terminal web links', () => {
  it('uses the xterm default handler for legacy and non-workspace bridges', () => {
    expect(createNativeWebLinkHandler(undefined, vi.fn())).toBeUndefined();
    expect(createNativeWebLinkHandler({ capabilities: {} }, vi.fn())).toBeUndefined();
  });

  it('opens the final HTTP(S) URL directly for the WK workspace bridge', () => {
    const open = vi.fn();
    const handler = createNativeWebLinkHandler({ capabilities: { webWorkspace: true } }, open)!;
    handler({} as MouseEvent, 'https://example.test/a');
    handler({} as MouseEvent, 'http://localhost:9834/path');
    expect(open.mock.calls).toEqual([
      ['https://example.test/a'],
      ['http://localhost:9834/path'],
    ]);
  });

  it('does not open non-web or malformed terminal text', () => {
    const open = vi.fn();
    const handler = createNativeWebLinkHandler({ capabilities: { webWorkspace: true } }, open)!;
    handler({} as MouseEvent, 'mailto:user@example.test');
    handler({} as MouseEvent, 'javascript:alert(1)');
    handler({} as MouseEvent, 'not a URL');
    expect(open).not.toHaveBeenCalled();
  });
});
