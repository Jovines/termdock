import { describe, expect, it } from 'vitest';
import {
  MOBILE_SESSION_DESTROY_DROPPABLE_ID,
  isMobileSessionDestroyDrop,
} from './mobileSessionDestroy';

describe('isMobileSessionDestroyDrop', () => {
  it('accepts a mobile session dropped on the destroy target', () => {
    expect(isMobileSessionDestroyDrop({
      type: 'session',
      destination: { droppableId: MOBILE_SESSION_DESTROY_DROPPABLE_ID },
    }, true)).toBe(true);
  });

  it('does not destroy desktop drops, group drags, or cancelled drops', () => {
    expect(isMobileSessionDestroyDrop({
      type: 'session',
      destination: { droppableId: MOBILE_SESSION_DESTROY_DROPPABLE_ID },
    }, false)).toBe(false);
    expect(isMobileSessionDestroyDrop({
      type: 'group',
      destination: { droppableId: MOBILE_SESSION_DESTROY_DROPPABLE_ID },
    }, true)).toBe(false);
    expect(isMobileSessionDestroyDrop({ type: 'session', destination: null }, true)).toBe(false);
  });
});
