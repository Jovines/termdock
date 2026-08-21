import { describe, expect, it } from 'vitest';
import {
  MAX_HIGHLIGHT_LINE_LENGTH,
  MAX_HIGHLIGHT_LINES,
  resolveLanguage,
  shouldHighlight,
} from './syntaxHighlight';

describe('syntax highlighting eligibility', () => {
  it('recognizes TSX source files', () => {
    expect(resolveLanguage('/workspace/src/RightSidebar.tsx')).toBe('tsx');
  });

  it('allows large hand-written TSX modules', () => {
    const source = Array.from(
      { length: 12_000 },
      (_, index) => `const row${index} = <span>{value}</span>;`,
    ).join('\n');

    expect(shouldHighlight(source)).toBe(true);
  });

  it('still rejects generated files beyond the line limit', () => {
    const generated = `${'export const value = 1;\n'.repeat(MAX_HIGHLIGHT_LINES)}export const value = 1;`;
    expect(shouldHighlight(generated)).toBe(false);
  });

  it('still rejects minified files with oversized lines', () => {
    expect(shouldHighlight('x'.repeat(MAX_HIGHLIGHT_LINE_LENGTH + 1))).toBe(false);
  });
});
