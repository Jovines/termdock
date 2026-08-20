import { describe, expect, it } from 'vitest';
import { buildBracketedPastePayload } from './bracketedPaste';

describe('buildBracketedPastePayload', () => {
  it('keeps every clipboard newline inside one protected paste block', () => {
    expect(buildBracketedPastePayload('first\rsecond\r', false)).toBe(
      '\x1b[200~first\rsecond\r\x1b[201~',
    );
  });

  it('places only an explicitly requested submit after the paste block', () => {
    expect(buildBracketedPastePayload('first\nsecond\r', true)).toBe(
      '\x1b[200~first\rsecond\x1b[201~\r',
    );
  });
});
