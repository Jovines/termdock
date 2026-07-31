import { describe, expect, it } from 'vitest';
import { getViewingPushClientIds, setClientViewingSession } from './pushViewers';

describe('push viewer tracking', () => {
  it('tracks per-session viewing state per push client', () => {
    setClientViewingSession('client-a1', 's1', true);
    setClientViewingSession('client-a1', 's2', true);
    setClientViewingSession('client-b1', 's1', true);

    expect(getViewingPushClientIds('s1')).toEqual(new Set(['client-a1', 'client-b1']));
    expect(getViewingPushClientIds('s2')).toEqual(new Set(['client-a1']));
    expect(getViewingPushClientIds('s3')).toEqual(new Set());
  });

  it('clears a session when the client stops viewing it', () => {
    setClientViewingSession('client-a2', 't1', true);
    setClientViewingSession('client-a2', 't2', true);
    setClientViewingSession('client-a2', 't1', false);

    expect(getViewingPushClientIds('t1')).toEqual(new Set());
    expect(getViewingPushClientIds('t2')).toEqual(new Set(['client-a2']));
  });

  it('ignores empty ids and unknown cleanup', () => {
    setClientViewingSession('', 'u1', true);
    setClientViewingSession('client-a3', '', true);
    setClientViewingSession('ghost', 'u1', false);
    expect(getViewingPushClientIds('u1')).toEqual(new Set());
  });
});
