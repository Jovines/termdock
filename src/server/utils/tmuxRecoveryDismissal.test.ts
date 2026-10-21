import { expect, it } from 'vitest';
import { canDismissTmuxRecoveryOperation } from './tmuxRecoveryDismissal';

it.each([
  ['queued', false, 0, false],
  ['running', false, 1, false],
  ['paused', true, 1, false],
  ['paused', true, 0, true],
  ['paused', false, 0, false], // Resource waits may resume automatically.
  ['resource_wait', false, 0, false],
  ['succeeded', false, 0, true],
  ['partial_failure', false, 0, true],
] as const)('dismissal for %s (manual pause %s, running %s) is %s', (state, paused, running, allowed) => {
  expect(canDismissTmuxRecoveryOperation({ state, paused, running })).toBe(allowed);
});
