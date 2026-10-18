import type { Request } from 'express';

// Object identity is deliberately used instead of a remotely forgeable header.
const verified = new WeakSet<object>();
const subjects = new WeakMap<object, string>();
const serviceAccess = new WeakSet<object>();
export function markEncryptedRequest(request: object, subjectId?: string, fullService = false): void {
  verified.add(request);
  if (subjectId) subjects.set(request, subjectId);
  if (fullService) serviceAccess.add(request);
}
export function isEncryptedRequest(request: Request): boolean { return verified.has(request); }
export function encryptedRequestSubject(request: object): string | undefined { return subjects.get(request); }
/** Set only by the target's authenticated internal dispatcher, never a page header. */
export function hasEncryptedServiceAccess(request: object): boolean { return serviceAccess.has(request); }
