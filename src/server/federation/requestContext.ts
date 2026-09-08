import type { Request } from 'express';

// Object identity is deliberately used instead of a remotely forgeable header.
const verified = new WeakSet<object>();
export function markEncryptedRequest(request: object): void { verified.add(request); }
export function isEncryptedRequest(request: Request): boolean { return verified.has(request); }
