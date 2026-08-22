import { describe, expect, it } from 'vitest';
import {
  drainTerminalOutputFrame,
  splitTerminalOutputChunk,
} from './outputBacklog';

describe('splitTerminalOutputChunk', () => {
  it('prefers newline boundaries without losing data', () => {
    const input = '1234\n5678\n90';
    const chunks = splitTerminalOutputChunk(input, 7);
    expect(chunks).toEqual(['1234\n', '5678\n90']);
    expect(chunks.join('')).toBe(input);
  });
});

describe('drainTerminalOutputFrame', () => {
  it('leaves a large wake-up backlog for later frames', () => {
    const pending = new Map([['active', ['aaaa', 'bbbb', 'cccc']]]);
    expect(drainTerminalOutputFrame(pending, 8, 10).get('active')).toEqual(['aaaa', 'bbbb']);
    expect(pending.get('active')).toEqual(['cccc']);
  });

  it('rotates a partially drained session behind other sessions', () => {
    const pending = new Map([
      ['busy', ['aaaa', 'bbbb']],
      ['other', ['cc']],
    ]);
    expect(drainTerminalOutputFrame(pending, 4, 10)).toEqual(new Map([['busy', ['aaaa']]]));
    expect([...pending.keys()]).toEqual(['other', 'busy']);
    expect(drainTerminalOutputFrame(pending, 4, 10)).toEqual(new Map([['other', ['cc']]]));
  });

  it('always makes progress for one chunk larger than the configured budget', () => {
    const pending = new Map([['active', ['oversized']]]);
    expect(drainTerminalOutputFrame(pending, 2, 1).get('active')).toEqual(['oversized']);
    expect(pending.size).toBe(0);
  });
});
