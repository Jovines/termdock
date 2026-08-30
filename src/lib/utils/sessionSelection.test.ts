import { describe, expect, it } from 'vitest';
import { pickSessionAfterClose } from './sessionSelection';

const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const getId = (session: { id: string }) => session.id;

describe('pickSessionAfterClose', () => {
  it('selects the previous session when closing a middle session', () => {
    expect(pickSessionAfterClose(sessions, 'b', getId)).toBe('a');
  });

  it('selects the previous session when closing the last session', () => {
    expect(pickSessionAfterClose(sessions, 'c', getId)).toBe('b');
  });

  it('selects the next session when the closed session has no predecessor', () => {
    expect(pickSessionAfterClose(sessions, 'a', getId)).toBe('b');
  });

  it('returns null when closing the only session', () => {
    expect(pickSessionAfterClose([{ id: 'a' }], 'a', getId)).toBeNull();
  });
});
