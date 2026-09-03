import { describe, expect, it } from 'vitest';
import {
  acknowledgeResize,
  createResizeSyncState,
  observeServerSize,
  requestResize,
  retryResize,
} from './resizeSync';

describe('terminal resize synchronization', () => {
  it('coalesces a duplicate pending size but supersedes it with a newer size', () => {
    const first = requestResize(createResizeSyncState(), { cols: 100, rows: 30 });
    expect(first.request).toMatchObject({ seq: 1, cols: 100, rows: 30, attempt: 0 });
    expect(requestResize(first.state, { cols: 100, rows: 30 }).request).toBeNull();

    const newer = requestResize(first.state, { cols: 120, rows: 32 });
    expect(newer.request).toMatchObject({ seq: 2, cols: 120, rows: 32 });
  });

  it('supersedes a pending resize when the viewport returns to the confirmed size', () => {
    const confirmed = observeServerSize(createResizeSyncState(), { cols: 100, rows: 30 });
    const wider = requestResize(confirmed, { cols: 120, rows: 30 });
    const returned = requestResize(wider.state, { cols: 100, rows: 30 });
    expect(returned.request).toMatchObject({ seq: 2, cols: 100, rows: 30 });
  });

  it('ignores an old acknowledgement after a newer resize was requested', () => {
    const first = requestResize(createResizeSyncState(), { cols: 100, rows: 30 });
    const newer = requestResize(first.state, { cols: 120, rows: 32 });
    const stale = acknowledgeResize(newer.state, {
      seq: first.request!.seq,
      ok: true,
      cols: 100,
      rows: 30,
    });
    expect(stale.accepted).toBe(false);
    expect(stale.state.pending?.seq).toBe(newer.request!.seq);
  });

  it('only records a size after a matching successful acknowledgement', () => {
    const queued = requestResize(createResizeSyncState(), { cols: 100, rows: 30 });
    expect(queued.state.confirmed).toBeNull();
    const acked = acknowledgeResize(queued.state, {
      seq: queued.request!.seq,
      ok: true,
      cols: 100,
      rows: 30,
    });
    expect(acked.accepted).toBe(true);
    expect(acked.state).toMatchObject({ confirmed: { cols: 100, rows: 30 }, pending: null });
  });

  it('retries once after a timeout and then leaves the size unconfirmed', () => {
    const queued = requestResize(createResizeSyncState(), { cols: 100, rows: 30 });
    const retry = retryResize(queued.state, queued.request!.seq);
    expect(retry.request).toMatchObject({ seq: 2, cols: 100, rows: 30, attempt: 1 });
    expect(retry.exhausted).toBe(false);

    const exhausted = retryResize(retry.state, retry.request!.seq);
    expect(exhausted.request).toBeNull();
    expect(exhausted.exhausted).toBe(true);
    expect(exhausted.state).toMatchObject({ confirmed: null, pending: null });
  });

  it('tracks authoritative sizes broadcast after another client resizes the PTY', () => {
    const state = observeServerSize(createResizeSyncState(), { cols: 88.9, rows: 27.4 });
    expect(state.confirmed).toEqual({ cols: 88, rows: 27 });
  });
});
