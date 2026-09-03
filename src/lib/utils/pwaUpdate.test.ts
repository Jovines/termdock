import { describe, expect, it, vi } from 'vitest';

import { createControllerChangeHandler } from './pwaUpdate';

describe('createControllerChangeHandler', () => {
  it('does not reload when a fresh install gets its first controller', () => {
    const reload = vi.fn();
    const onControllerChange = createControllerChangeHandler(false, reload);

    onControllerChange();

    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads when an existing controller is replaced by an update', () => {
    const reload = vi.fn();
    const onControllerChange = createControllerChangeHandler(true, reload);

    onControllerChange();

    expect(reload).toHaveBeenCalledOnce();
  });

  it('reloads later replacements after suppressing a first install reload', () => {
    const reload = vi.fn();
    const onControllerChange = createControllerChangeHandler(false, reload);

    onControllerChange();
    onControllerChange();

    expect(reload).toHaveBeenCalledOnce();
  });
});
