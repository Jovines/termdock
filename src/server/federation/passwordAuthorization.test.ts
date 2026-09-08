import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthorizationStore } from './authorization.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'td-password-grants-')); dirs.push(dir);
  let credential: string | null = 'a'.repeat(64);
  let now = 1000;
  const store = new AuthorizationStore({ filePath: join(dir, 'grants.json'), serviceId: 'target', now: () => now, passwordCredential: () => credential });
  const allowed = (subjectId: string) => store.authorize({ subjectId, serviceId: 'target', action: 'session.view', sessionId: 's1' }).allowed;
  return { store, allowed, change: (value: string | null) => { credential = value; }, time: (value: number) => { now = value; } };
}
describe('password credential bound grants', () => {
  it.each(['b'.repeat(64), null])('revokes parent and descendants immediately on credential change/removal', next => {
    const f = fixture(); const parent = f.store.grantPassword('phone');
    const child = f.store.delegate(parent.id, 'phone', { subjectId: 'child', scope: { kind: 'sessions', sessionIds: ['s1'] }, actions: ['session.view'], expiresAt: parent.expiresAt });
    expect(f.allowed('phone')).toBe(true); expect(f.allowed('child')).toBe(true);
    f.change(next);
    expect(f.allowed('phone')).toBe(false); expect(f.allowed('child')).toBe(false);
    expect(f.store.listEffective({ subjectId: 'child', serviceId: 'target' })).toEqual([]);
    expect(f.store.hasFullServiceAccess({ subjectId: 'phone', serviceId: 'target' })).toBe(false);
    expect(() => f.store.delegate(parent.id, 'phone', { subjectId: 'new-child', scope: { kind: 'sessions', sessionIds: ['s1'] }, actions: ['session.view'], expiresAt: child.expiresAt })).toThrow();
  });
  it('re-login revokes the old grant and descendants while the new grant is valid for 30 days', () => {
    const f = fixture(); const old = f.store.grantPassword('phone');
    f.store.delegate(old.id, 'phone', { subjectId: 'child', scope: { kind: 'sessions', sessionIds: ['s1'] }, actions: ['session.view'], expiresAt: old.expiresAt });
    const current = f.store.grantPassword('phone');
    expect(current.id).not.toBe(old.id);
    expect(f.store.list().find(g => g.id === old.id)?.revokedAt).toBe(1000);
    expect(f.allowed('phone')).toBe(true); expect(f.allowed('child')).toBe(false);
    expect(current.expiresAt).toBe(1000 + 30 * 24 * 60 * 60 * 1000);
    f.time(current.expiresAt!); expect(f.allowed('phone')).toBe(false);
  });
  it('cannot issue a password grant when password authentication is unavailable', () => {
    const f = fixture(); f.change(null); expect(() => f.store.grantPassword('phone')).toThrow();
  });
});
