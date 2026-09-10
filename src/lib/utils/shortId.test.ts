import { describe, expect, it } from 'vitest';
import { shortId } from './shortId';

describe('shortId', () => {
  it('shortens canonical UUIDs the way the server does', () => {
    expect(shortId('765c8819-ae14-46ae-b615-186eb5fd8b1f')).toBe('765c8819');
  });

  it('passes through ids that are already short or structurally parsed', () => {
    // Twin of the server's canonicalShortId: same inputs, same output.
    expect(shortId('40bc89py')).toBe('40bc89py');
    expect(shortId('cross-765c8819-ae14-46ae-b615-186eb5fd8b1f')).toBe('cross-765c8819-ae14-46ae-b615-186eb5fd8b1f');
    expect(shortId('')).toBe('');
  });
});
