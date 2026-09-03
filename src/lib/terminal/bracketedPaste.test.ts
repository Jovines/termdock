import { describe, expect, it } from 'vitest';
import { buildBracketedPastePayload, detectTextareaPaste } from './bracketedPaste';

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

describe('detectTextareaPaste', () => {
  it('extracts text from a native mobile paste inserted after an existing draft', () => {
    expect(detectTextareaPaste('draft: ', 'draft: first\rsecond', 'insertFromPaste')).toBe(
      'first\rsecond',
    );
  });

  it('recognizes multiline insertion when a mobile browser reports a generic input type', () => {
    expect(detectTextareaPaste('', 'first\rsecond\rthird', 'insertText')).toBe(
      'first\rsecond\rthird',
    );
  });

  it('extracts pasted text that replaces a selection', () => {
    expect(detectTextareaPaste('before OLD after', 'before new\rtext after', 'insertFromPaste')).toBe(
      'new\rtext',
    );
  });

  it('leaves ordinary typing on the normal textarea sync path', () => {
    expect(detectTextareaPaste('hello', 'hello!', 'insertText')).toBeNull();
  });
});
