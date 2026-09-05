// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveTerminalReplayCursor, TerminalOutputDelivery, type OutputFrame } from './terminalOutputDelivery.js';

describe('per-observer terminal output', () => {
  it('sends replay before newer live frames without duplicating captured frames', () => {
    const sent: OutputFrame[] = [];
    const delivery = new TerminalOutputDelivery((frame) => sent.push(frame), true);
    delivery.enqueue({ type: 'data', data: 'old', seq: 2 });
    delivery.enqueue({ type: 'data', data: 'new', seq: 3 });
    expect(sent).toEqual([]);
    delivery.finishReplay(2);
    expect(sent.map((frame) => frame.data)).toEqual(['new']);
  });

  it('bounds output until consumption ACK and rejects future ACKs', () => {
    const sent: OutputFrame[] = [];
    const delivery = new TerminalOutputDelivery((frame) => sent.push(frame), true, 4, 16);
    delivery.finishReplay(0);
    delivery.enqueue({ type: 'data', data: '1234' });
    delivery.enqueue({ type: 'data', data: '5678' });
    expect(sent).toHaveLength(1);
    delivery.acknowledge(100);
    expect(sent).toHaveLength(1);
    delivery.acknowledge(sent[0].flowSeq!);
    expect(sent.map((frame) => frame.data)).toEqual(['1234', '5678']);
  });

  it('does not retain hidden output and falls back to replay after overflow', () => {
    const sent: OutputFrame[] = [];
    const delivery = new TerminalOutputDelivery((frame) => sent.push(frame), true, 4, 8);
    delivery.finishReplay(0);
    delivery.setActive(false);
    delivery.enqueue({ type: 'data', data: 'not visible' });
    expect(delivery.pendingBytes).toBe(0);
    delivery.setActive(true);
    delivery.enqueue({ type: 'data', data: 'way too much output' });
    expect(delivery.needsReplay).toBe(true);
    expect(delivery.pendingBytes).toBe(0);
  });

  it('only resumes a cursor within its server epoch', () => {
    expect(resolveTerminalReplayCursor(100, 'old', 'new')).toBe(0);
    expect(resolveTerminalReplayCursor(100, undefined, 'new')).toBe(0);
    expect(resolveTerminalReplayCursor(100, 'new', 'new')).toBe(100);
    expect(resolveTerminalReplayCursor(Infinity, 'new', 'new')).toBe(0);
  });
});

it('requests recovery even when an oversized frame has no ACK in flight', () => {
  let recoveries = 0;
  const delivery = new TerminalOutputDelivery(() => undefined, true, 4, 8, () => { recoveries += 1; });
  delivery.finishReplay(0);
  delivery.enqueue({ type: 'data', data: 'oversized output' });
  delivery.enqueue({ type: 'data', data: 'more' });
  expect(recoveries).toBe(1);
});
