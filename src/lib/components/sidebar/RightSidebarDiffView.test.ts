import { describe, expect, it } from 'vitest';
import { resolveRightSidebarDiffViewType } from './RightSidebar';

describe('resolveRightSidebarDiffViewType', () => {
  it('keeps side-by-side viewing available in a pinned narrow desktop sidebar', () => {
    expect(resolveRightSidebarDiffViewType(true, true, 'split')).toBe('split');
  });

  it('keeps an unpinned narrow drawer unified for phone-sized overlays', () => {
    expect(resolveRightSidebarDiffViewType(true, false, 'split')).toBe('unified');
  });

  it('preserves the selected view in a wide sidebar', () => {
    expect(resolveRightSidebarDiffViewType(false, true, 'split')).toBe('split');
    expect(resolveRightSidebarDiffViewType(false, true, 'unified')).toBe('unified');
  });
});
