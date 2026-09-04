// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { isResponseWritable, writeResponseChunk, type WritableHttpResponse } from './httpResponse.js';

function createResponse(overrides: Partial<WritableHttpResponse> = {}): WritableHttpResponse {
  return {
    destroyed: false,
    writableEnded: false,
    writableFinished: false,
    write: vi.fn(),
    ...overrides,
  };
}

describe('writeResponseChunk', () => {
  it('writes while the response is open', () => {
    const response = createResponse();

    expect(isResponseWritable(response)).toBe(true);
    expect(writeResponseChunk(response, 'event\n')).toBe(true);
    expect(response.write).toHaveBeenCalledWith('event\n');
  });

  it.each([
    ['destroyed', { destroyed: true }],
    ['ended', { writableEnded: true }],
    ['finished', { writableFinished: true }],
  ] as const)('does not write after a response is %s', (_state, overrides) => {
    const response = createResponse(overrides);

    expect(isResponseWritable(response)).toBe(false);
    expect(writeResponseChunk(response, 'event\n')).toBe(false);
    expect(response.write).not.toHaveBeenCalled();
  });

  it('contains synchronous stream write failures', () => {
    const response = createResponse({ write: vi.fn(() => { throw new Error('socket closed'); }) });

    expect(writeResponseChunk(response, 'event\n')).toBe(false);
  });
});
