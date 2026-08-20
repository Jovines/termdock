import { describe, expect, it } from 'vitest';
import { resolveImeAnchorOffset } from './imeAnchor';

function elementAt(left: number, top: number, clientLeft = 0, clientTop = 0): HTMLElement {
  return {
    clientLeft,
    clientTop,
    getBoundingClientRect: () => ({ left, top }),
  } as HTMLElement;
}

describe('resolveImeAnchorOffset', () => {
  it('includes the terminal vertical offset inside a transformed containing block', () => {
    const containingBlock = elementAt(305, 18);
    const terminal = elementAt(305, 86);

    expect(resolveImeAnchorOffset(terminal, containingBlock, 96, 51)).toEqual({
      x: 96,
      y: 119,
    });
  });

  it('does not double-count a pinned sidebar offset', () => {
    const containingBlock = elementAt(305, 0);
    const terminal = elementAt(305, 64);

    expect(resolveImeAnchorOffset(terminal, containingBlock, 80, 34)).toEqual({
      x: 80,
      y: 98,
    });
  });

  it('uses viewport coordinates when there is no fixed containing block', () => {
    const terminal = elementAt(24, 64);

    expect(resolveImeAnchorOffset(terminal, null, 80, 34)).toEqual({
      x: 104,
      y: 98,
    });
  });
});
