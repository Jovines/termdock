import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InvitationStore } from './invitations.js';
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'termdock-invites-')); directories.push(directory);
  const filePath = join(directory, 'invitations.json'); let now = 1000;
  const options = { filePath, serviceId: 'service-C', now: () => now };
  return { filePath, store: new InvitationStore(options), reload: () => new InvitationStore(options), advance: (ms: number) => { now += ms; } };
}
describe('single-use device invitations', () => {
  it('lists pending metadata and persists revocation without disclosing a usable code', () => {
    const f = fixture();
    const input = { scope: { kind: 'sessions' as const, sessionIds: ['one'] }, actions: ['session.view', 'session.input'], label: '工作手机' };
    const invite = f.store.create('admin', input);
    const other = f.store.create('admin', input);
    expect(f.reload().listPending()).toEqual([
      { ...input, id: invite.invitationId, createdAt: 1000, invitationExpiresAt: 601000 },
      { ...input, id: other.invitationId, createdAt: 1000, invitationExpiresAt: 601000 },
    ]);
    expect(JSON.stringify(f.store.listPending())).not.toContain(invite.code);
    expect(f.store.revoke(invite.invitationId)).toBe(true);
    expect(f.reload().revoke(invite.invitationId)).toBe(false);
    expect(() => f.reload().consume(invite.code, 'phone', () => true)).toThrow('PAIRING_DENIED');
    expect(f.reload().consume(other.code, 'phone', () => true)).toMatchObject({ subjectId: 'phone' });
    expect(f.store.revoke(other.invitationId)).toBe(false);
    expect(f.store.listPending()).toEqual([]);
    expect(f.store.subjectLabels()).toEqual({ phone: '工作手机' });
  });
  it('omits expired links and expired authorizations from pending invitations', () => {
    const f = fixture();
    f.store.create('admin', { scope: { kind: 'service' }, actions: ['session.view'], expiresAt: 1500 });
    f.advance(500);
    expect(f.store.listPending()).toEqual([]);
    f.store.create('admin', { scope: { kind: 'service' }, actions: ['session.view'] });
    f.advance(600000);
    expect(f.store.listPending()).toEqual([]);
  });
  it('persists only a private hash and binds redemption to the actual device without broadening scope', () => {
    const f = fixture();
    const invitation = f.store.create('admin', { scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view'], label: '工作手机', expiresAt: 900000 });
    expect(invitation.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invitation.expiresAt).toBe(601000);
    expect(readFileSync(f.filePath, 'utf8')).not.toContain(invitation.code);
    expect(statSync(f.filePath).mode & 0o777).toBe(0o600);
    expect(f.store.consume(invitation.code, 'real-phone', issuer => issuer === 'admin')).toEqual({ subjectId: 'real-phone', scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.view'], canDelegate: false, expiresAt: 900000 });
    expect(f.store.subjectLabels()).toEqual({ 'real-phone': '工作手机' });
    expect(() => f.reload().consume(invitation.code, 'other-phone', () => true)).toThrow('PAIRING_DENIED');
  });
  it('supports all-session custom read access without administrator wildcard', () => {
    const f = fixture();
    const invite = f.store.create('admin', { scope: { kind: 'service' }, actions: ['session.view'] });
    expect(f.store.consume(invite.code, 'phone', () => true)).toMatchObject({ scope: { kind: 'service' }, actions: ['session.view'], canDelegate: false });
  });
  it('rejects expired codes and invitations whose issuer lost management permission', () => {
    const f = fixture();
    const invitation = f.store.create('admin', { scope: { kind: 'service' }, actions: ['service:*'] });
    expect(() => f.store.consume(invitation.code, 'phone', () => false)).toThrow('PAIRING_DENIED');
    f.advance(600000);
    expect(() => f.store.consume(invitation.code, 'phone', () => true)).toThrow('PAIRING_DENIED');
  });
  it('rejects privilege injection and invalid scope/action combinations', () => {
    const f = fixture();
    for (const value of [
      { scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['service:*'] },
      { scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['file.read'] },
      { scope: { kind: 'sessions', sessionIds: ['one'] }, actions: ['session.fake'] },
      { scope: { kind: 'service' }, actions: ['service:*'], subjectId: 'forged' },
      { scope: { kind: 'service' }, actions: ['service:*'], canDelegate: true },
    ]) expect(() => f.store.create('admin', value as Parameters<InvitationStore['create']>[1])).toThrow('INVALID_INVITATION');
  });
});
