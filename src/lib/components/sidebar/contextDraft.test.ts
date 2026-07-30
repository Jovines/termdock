import { describe, expect, it } from 'vitest';
import { appendContextDraft, buildDraftTerminalPayload } from './contextDraft';

describe('context draft helpers', () => {
  it('keeps independently inserted context chunks readable', () => {
    expect(appendContextDraft('请检查这里', '/repo/src/App.tsx '))
      .toBe('请检查这里\n\n/repo/src/App.tsx');
    expect(appendContextDraft('first\n', 'second')).toBe('first\n\nsecond');
  });

  it('does not add empty context chunks', () => {
    expect(appendContextDraft('existing', '   ')).toBe('existing');
  });

  it('builds insert and submit terminal payloads', () => {
    expect(buildDraftTerminalPayload('hello', false)).toBe('hello ');
    expect(buildDraftTerminalPayload('hello ', false)).toBe('hello ');
    expect(buildDraftTerminalPayload('hello\nworld', true)).toBe('hello\nworld\r');
    expect(buildDraftTerminalPayload('  ', true)).toBe('');
  });
});
