import { describe, expect, it, vi } from 'vitest';
import { activateSplitPaneForWheel } from './splitPaneWheelActivation';

describe('split pane wheel activation', () => {
  it('activates an inactive pane before returning to wheel propagation', () => {
    const activate = vi.fn();

    activateSplitPaneForWheel(false, activate);

    expect(activate).toHaveBeenCalledOnce();
  });

  it('leaves an already active pane unchanged', () => {
    const activate = vi.fn();

    activateSplitPaneForWheel(true, activate);

    expect(activate).not.toHaveBeenCalled();
  });
});
