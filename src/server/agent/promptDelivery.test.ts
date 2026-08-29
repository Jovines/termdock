import { describe, expect, it } from 'vitest';
import { buildBracketedSubmitBytes } from './promptDelivery.js';

describe('buildBracketedSubmitBytes', () => {
  it('keeps multiline prompts in one paste block and submits once', () => {
    expect(buildBracketedSubmitBytes('first\nsecond\r\nthird')).toBe(
      '\x1b[200~first\rsecond\rthird\x1b[201~\r',
    );
  });

  it('neutralizes escape bytes from prompt content', () => {
    expect(buildBracketedSubmitBytes('safe\x1b[201~injected')).toBe(
      '\x1b[200~safe␛[201~injected\x1b[201~\r',
    );
  });
});
