import type { Request } from 'express';

// Object identity is deliberately used instead of a remotely forgeable header.
const verified = new WeakSet<object>();
const subjects = new WeakMap<object, string>();
export function markEncryptedRequest(request: object, subjectId?: string): void {
  verified.add(request);
  if (subjectId) subjects.set(request, subjectId);
}
export function isEncryptedRequest(request: Request): boolean { return verified.has(request); }
export function encryptedRequestSubject(request: object): string | undefined { return subjects.get(request); }
