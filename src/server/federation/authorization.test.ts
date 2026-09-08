import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthorizationStore, type GrantInput } from './authorization.js';
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'td-auth-')); dirs.push(dir);
  const filePath = join(dir, 'private', 'grants.json'); let now = 1000;
  const store = new AuthorizationStore({ filePath, serviceId: 'C', now: () => now });
  const allowed = (action: string, sessionId = 's1', subjectId = 'phone') => store.authorize({ subjectId, serviceId: 'C', action, sessionId }).allowed;
  return { store, filePath, allowed, setTime: (n: number) => { now = n; } };
}
const read: GrantInput = { subjectId: 'phone', scope: { kind: 'sessions', sessionIds: ['s1'] }, actions: ['session.view'] };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('target authorization authority', () => {
  it('denies unknown subjects, services and ungranted operations', () => {
    const { store, allowed } = fixture(); expect(allowed('session.view')).toBe(false); store.grant(read);
    expect(allowed('session.view')).toBe(true); expect(allowed('session.input')).toBe(false);
    expect(allowed('session.resize')).toBe(false); expect(allowed('session.terminate')).toBe(false);
    expect(allowed('session.view', 's2')).toBe(false); expect(allowed('session.view', 's1', 'relay')).toBe(false);
    expect(store.authorize({ subjectId: 'phone', serviceId: 'B', action: 'session.view', sessionId: 's1' }).allowed).toBe(false);
  });
  it('combines whole matching grants without cross-combining scope and actions', () => {
    const { store, allowed } = fixture(); store.grant(read);
    store.grant({ ...read, scope: { kind: 'sessions', sessionIds: ['s2'] }, actions: ['session.input'] });
    expect(allowed('session.input', 's1')).toBe(false); expect(allowed('session.view', 's2')).toBe(false);
    expect(allowed('session.input', 's2')).toBe(true);
    const broad = store.grant({ subjectId: 'phone', scope: { kind: 'service' }, actions: ['service:*'] });
    expect(allowed('file.write')).toBe(true); expect(allowed('future.capability')).toBe(true);
    store.revoke(broad.id); expect(allowed('file.write')).toBe(false); expect(allowed('session.view')).toBe(true);
  });
  it('distinguishes full-service wildcard from a custom action with the same descriptive name', () => {
    const { store } = fixture(); const request = { subjectId: 'phone', serviceId: 'C' };
    store.grant({ subjectId: 'phone', scope: { kind: 'service' }, actions: ['service.full-access'] });
    expect(store.hasFullServiceAccess(request)).toBe(false);
    const broad = store.grant({ subjectId: 'phone', scope: { kind: 'service' }, actions: ['service:*'] });
    expect(store.hasFullServiceAccess(request)).toBe(true);
    store.revoke(broad.id); expect(store.hasFullServiceAccess(request)).toBe(false);
    expect(store.listEffective(request).map(g => g.id)).not.toContain(broad.id);
  });
  it('requires concrete session actions and rejects malformed grants', () => {
    const { store } = fixture();
    expect(() => store.grant({ ...read, actions: ['service:*'] })).toThrow();
    expect(() => store.grant({ ...read, actions: ['file.read'] })).toThrow();
    expect(() => store.grant({ ...read, scope: { kind: 'sessions', sessionIds: [] } })).toThrow();
    expect(() => store.grant({ ...read, actions: ['session.*'] })).toThrow();
    expect(() => store.grant({ ...read, expiresAt: NaN })).toThrow();
    expect(() => store.grant({ ...read, conditions: { relayIds: [] } })).toThrow();
    store.grant({ ...read, scope: { kind: 'service' }, actions: ['service:*'] });
    expect(store.authorize({ subjectId: 'phone', serviceId: 'C', action: 'session.view' }).allowed).toBe(false);
    expect(store.authorize({ subjectId: 'phone', serviceId: 'C', action: 'service:*' }).allowed).toBe(false);
  });
  it('enforces expiry and bounded delegation with cascading revocation', () => {
    const { store, allowed, setTime } = fixture();
    const parent = store.grant({ ...read, canDelegate: true, expiresAt: 2000 });
    const child = store.delegate(parent.id, 'phone', { ...read, subjectId: 'child', canDelegate: true, expiresAt: 1800 });
    store.delegate(child.id, 'child', { ...read, subjectId: 'grandchild', expiresAt: 1700 });
    expect(allowed('session.view', 's1', 'grandchild')).toBe(true);
    expect(() => store.delegate(parent.id, 'impostor', { ...read, expiresAt: 1800 })).toThrow();
    for (const input of [
      { ...read, actions: ['session.input'], expiresAt: 1800 },
      { ...read, scope: { kind: 'service' } as const, expiresAt: 1800 },
      { ...read, expiresAt: 2001 }, read,
    ]) expect(() => store.delegate(parent.id, 'phone', input)).toThrow();
    setTime(1700); expect(allowed('session.view', 's1', 'grandchild')).toBe(false);
    expect(allowed('session.view', 's1', 'child')).toBe(true);
    store.revoke(parent.id); expect(allowed('session.view', 's1', 'child')).toBe(false);
  });
  it('enforces route constraints and prevents delegation from dropping them', () => {
    const { store } = fixture(); const conditions = { entryServiceIds: ['B'], relayIds: ['A'] };
    const parent = store.grant({ ...read, canDelegate: true, conditions });
    expect(() => store.delegate(parent.id, 'phone', read)).toThrow();
    const request = { subjectId: 'phone', serviceId: 'C', action: 'session.view', sessionId: 's1' };
    expect(store.authorize(request).allowed).toBe(false);
    expect(store.authorize({ ...request, entryServiceId: 'B', relayId: 'A' }).allowed).toBe(true);
    expect(store.authorize({ ...request, entryServiceId: 'B', relayId: 'evil' }).allowed).toBe(false);
  });
  it('persists with private permissions and fails closed on corruption', () => {
    const { store, filePath, allowed } = fixture(); const grant = store.grant(read);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(statSync(join(filePath, '..')).mode & 0o777).toBe(0o700);
    const reopened = new AuthorizationStore({ filePath, serviceId: 'C', now: () => 1000 });
    expect(reopened.list()[0].id).toBe(grant.id);
    const copy = reopened.list(); copy[0].actions.push('session.input'); expect(allowed('session.input')).toBe(false);
    writeFileSync(filePath, '{broken'); expect(allowed('session.view')).toBe(false);
    expect(() => store.grant(read)).toThrow();
  });
  it('does not accept orphaned or cyclic delegation in persisted data', () => {
    const { store, filePath, allowed } = fixture(); store.grant(read);
    const data = JSON.parse(readFileSync(filePath, 'utf8')); data.grants[0].parentGrantId = data.grants[0].id;
    data.grants[0].canDelegate = true; writeFileSync(filePath, JSON.stringify(data));
    expect(allowed('session.view')).toBe(false);
    data.grants[0].parentGrantId = 'missing'; writeFileSync(filePath, JSON.stringify(data)); expect(allowed('session.view')).toBe(false);
  });
});
