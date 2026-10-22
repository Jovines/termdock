import { expect, it } from 'vitest';
import { InteractiveOutput } from './interactiveOutput';

it('flushes the first small echo once while keeping continuous output batched', () => {
  const delivery = new InteractiveOutput();
  expect(delivery.consume(1, 0, true)).toBe(false);
  delivery.input(10);
  expect(delivery.consume(20, 150, true)).toBe(true);
  expect(delivery.consume(20, 170, true)).toBe(false);
  delivery.input(180);
  expect(delivery.consume(20, 200, true)).toBe(true);
});

it('preserves batching for hidden, large, expired and same-frame responses', () => {
  const delivery = new InteractiveOutput();
  delivery.input(0); expect(delivery.consume(20, 10, false)).toBe(false);
  delivery.input(20); expect(delivery.consume(8193, 30, true)).toBe(false);
  delivery.input(40); expect(delivery.consume(20, 1600, true)).toBe(false);
  delivery.input(1700); expect(delivery.consume(20, 1710, true)).toBe(true);
  delivery.input(1711); expect(delivery.consume(20, 1715, true)).toBe(false);
});
