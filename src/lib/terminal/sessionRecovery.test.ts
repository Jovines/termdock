import { describe, expect, it } from 'vitest';
import {
  BACKEND_SESSION_MISS_MESSAGE,
  STALE_SESSION_RESTORE_REJECTED,
  isConfirmedSessionMissing,
  isTransientBackendSessionMiss,
} from './sessionRecovery';

describe('terminal session recovery classification', () => {
  it('treats an in-memory backend miss as recoverable', () => {
    expect(isTransientBackendSessionMiss({ message: BACKEND_SESSION_MISS_MESSAGE })).toBe(true);
    expect(isConfirmedSessionMissing({ code: undefined })).toBe(false);
  });

  it('only confirms a missing session from the explicit restore rejection code', () => {
    expect(isConfirmedSessionMissing({ code: STALE_SESSION_RESTORE_REJECTED })).toBe(true);
    expect(isConfirmedSessionMissing({ code: 'NOT_READY' })).toBe(false);
  });
});
