import { afterEach, describe, expect, it } from 'vitest';
import { getForegroundPushClientIds, setClientViewingSession } from './pushViewers';

describe('push viewer tracking', () => {
  afterEach(() => {
    for (const [clientId, sessionId] of [
      ['client-a1', 's1'],
      ['client-a1', 's2'],
      ['client-b1', 's1'],
      ['client-a2', 't1'],
      ['client-a2', 't2'],
      ['client-a3', 'u1'],
    ]) {
      setClientViewingSession(clientId, sessionId, false);
    }
  });

  it('treats viewing any session as foreground app presence', () => {
    setClientViewingSession('client-a1', 's1', true);
    setClientViewingSession('client-a1', 's2', true);
    setClientViewingSession('client-b1', 's1', true);

    expect(getForegroundPushClientIds()).toEqual(new Set(['client-a1', 'client-b1']));
  });

  it('clears a session when the client stops viewing it', () => {
    setClientViewingSession('client-a2', 't1', true);
    setClientViewingSession('client-a2', 't2', true);
    setClientViewingSession('client-a2', 't1', false);

    expect(getForegroundPushClientIds()).toEqual(new Set(['client-a2']));

    setClientViewingSession('client-a2', 't2', false);
    expect(getForegroundPushClientIds()).toEqual(new Set());
  });

  it('ignores empty ids and unknown cleanup', () => {
    setClientViewingSession('', 'u1', true);
    setClientViewingSession('client-a3', '', true);
    setClientViewingSession('ghost', 'u1', false);
    expect(getForegroundPushClientIds()).toEqual(new Set());
  });
});
