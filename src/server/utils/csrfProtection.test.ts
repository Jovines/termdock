import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { CsrfProtection } from './csrfProtection.js';

function responseMock() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { response: { status } as unknown as Response, status, json };
}

describe('CSRF protection local bypass', () => {
  it('uses only the caller-supplied trusted-request predicate', () => {
    const csrf = new CsrfProtection();
    const request = {
      method: 'POST',
      path: '/api/terminal/agent-plugins/install',
      cookies: {},
      headers: {},
    } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;
    const { response, status } = responseMock();

    csrf.verifyMiddleware({ bypass: () => true })(request, response, next);

    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it('still rejects an untrusted mutation without a matching cookie/header token', () => {
    const csrf = new CsrfProtection();
    const request = {
      method: 'POST',
      path: '/api/terminal/agent-plugins/install',
      cookies: {},
      headers: {},
    } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;
    const { response, status, json } = responseMock();

    csrf.verifyMiddleware({ bypass: () => false })(request, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CSRF_ERROR' }));
  });
});
