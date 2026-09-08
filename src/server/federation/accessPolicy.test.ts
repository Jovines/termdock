import { describe, expect, it } from 'vitest';
import { isBusinessApiPath, resolveAccessRequest, terminalMessageAction } from './accessPolicy.js';
describe('encrypted tunnel access policy', () => {
  it('maps backend Session operations to separate capabilities', () => {
    for (const op of ['health', 'attach', 'stream', 'agent-resume']) expect(resolveAccessRequest('GET', `/api/terminal/s1/${op}?since=1`)).toEqual({ action: 'session.view', sessionId: 's1' });
    expect(resolveAccessRequest('POST', '/api/terminal/s1/input')).toEqual({ action: 'session.input', sessionId: 's1' });
    expect(resolveAccessRequest('POST', '/api/terminal/s1/resize')).toEqual({ action: 'session.resize', sessionId: 's1' });
    expect(resolveAccessRequest('DELETE', '/api/terminal/s1')).toEqual({ action: 'session.terminate', sessionId: 's1' });
    expect(resolveAccessRequest('GET', '/api/terminal/s1/input')).toBeNull();
  });
  it('never treats global inventory as scoped Session metadata', () => {
    expect(resolveAccessRequest('GET', '/api/terminal/client-state')).toEqual({ action: 'service.view', metadata: 'global-client-state' });
    expect(resolveAccessRequest('GET', '/api/terminal/session-inventory')).toEqual({ action: 'service.view', metadata: 'session-inventory' });
    expect(resolveAccessRequest('DELETE', '/api/terminal/client-state')).toBeNull();
    expect(resolveAccessRequest('GET', '/api/terminal/settings/attach')).toBeNull();
  });
  it('requires service authority for cross-session tmux switching and launches', () => {
    for (const op of ['tmux', 'restart', 'agent-resume']) expect(resolveAccessRequest('POST', `/api/terminal/s1/${op}`)).toEqual({ action: 'service.configure' });
    expect(terminalMessageAction('tmux')).toBe('service.configure');
    expect(terminalMessageAction('focus')).toBe('session.input');
    expect(terminalMessageAction('flow-control')).toBe('session.input');
  });
  it('separates file reads, mutations and service configuration', () => {
    expect(resolveAccessRequest('GET', '/api/terminal/fs/read?path=/etc/passwd')).toEqual({ action: 'file.read' });
    expect(resolveAccessRequest('POST', '/api/terminal/fs/upload')).toEqual({ action: 'file.write' });
    expect(resolveAccessRequest('GET', '/api/terminal/fs/cancel-slot')).toEqual({ action: 'file.write' });
    expect(resolveAccessRequest('PUT', '/api/terminal/settings')).toEqual({ action: 'service.configure' });
    expect(resolveAccessRequest('GET', '/api/terminal/fs/new-operation')).toBeNull();
  });
  it('denies unknown mappings while allowing explicit full-service business fallback', () => {
    expect(resolveAccessRequest('POST', '/api/future/new-capability')).toBeNull();
    expect(isBusinessApiPath('POST', '/api/future/new-capability')).toBe(true);
    expect(terminalMessageAction('future-message')).toBeNull();
  });
  it('decodes UTF-8 filename segments once while preserving reserved-route authorization', () => {
    expect(resolveAccessRequest('GET', '/api/terminal/fs/preview/abcdef0123456789abcdef0123456789/%E4%B8%AD%E6%96%87%20dir/index.html')).toEqual({ action: 'file.read' });
    expect(resolveAccessRequest('GET', '/api/terminal/fs/preview/abcdef0123456789abcdef0123456789/docs/')).toEqual({ action: 'file.read' });
    expect(resolveAccessRequest('GET', '/api/terminal/%63lient-state')).toEqual({ action: 'service.view', metadata: 'global-client-state' });
    expect(resolveAccessRequest('DELETE', '/api/terminal/%43LIENT-STATE')).toBeNull();
    for (const segment of ['%2F', '%5c', '%00', '%2e%2e', '%252e%252e', '%C0%AF', '%E4%ZZ']) expect(isBusinessApiPath('GET', '/api/terminal/fs/preview/token/' + segment)).toBe(false);
  });
  it('rejects URL tricks and nonbusiness or recursive tunnel routes', () => {
    for (const path of ['https://evil/api/terminal/s1/attach', '//evil/api/x', '/api/terminal/../auth/login', '/api/terminal/%2e%2e/auth/login', '/api/terminal/s1%2finput', '/api//terminal/s1', '/api/terminal/s1\\input', '/api/auth/login', '/api/local/change-audit', '/api/federation/tunnel', '/api/terminal/s1/attach#x', '/api/terminal/s1/attach/']) {
      expect(isBusinessApiPath('GET', path), path).toBe(false); expect(resolveAccessRequest('GET', path), path).toBeNull();
    }
    expect(isBusinessApiPath('CONNECT', '/api/terminal/s1')).toBe(false);
  });
});
