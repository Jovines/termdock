export const BACKEND_SESSION_MISS_MESSAGE = 'Session not found on server';
export const CONFIRMED_SESSION_MISSING_MESSAGE = 'Terminal session not found';
export const STALE_SESSION_RESTORE_REJECTED = 'STALE_SESSION_RESTORE_REJECTED';

export function isTransientBackendSessionMiss(error: { message?: string } | null | undefined): boolean {
  return error?.message === BACKEND_SESSION_MISS_MESSAGE;
}

export function isConfirmedSessionMissing(error: { code?: string } | null | undefined): boolean {
  return error?.code === STALE_SESSION_RESTORE_REJECTED;
}
