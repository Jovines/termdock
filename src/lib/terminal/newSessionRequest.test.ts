import { describe, expect, it } from 'vitest';
import { classifySessionCreationError } from './newSessionRequest';

describe('session creation feedback', () => {
  it('maps recoverable failures without presenting paths, stack traces or transport detail', () => {
    expect(classifySessionCreationError(new Error('Directory does not exist: /private/path'))).toBe('directoryUnavailable');
    expect(classifySessionCreationError(new Error('Path is not a directory: /private/path'))).toBe('directoryUnavailable');
    expect(classifySessionCreationError(new Error('EACCES: permission denied'))).toBe('permissionDenied');
    expect(classifySessionCreationError(new TypeError('Failed to fetch'))).toBe('connection');
    expect(classifySessionCreationError(new Error('Request timed out'))).toBe('connection');
    expect(classifySessionCreationError(new Error('private diagnostic'))).toBe('unknown');
    expect(classifySessionCreationError(new Error('spawn shell ENOENT'))).toBe('unknown');
  });
});
