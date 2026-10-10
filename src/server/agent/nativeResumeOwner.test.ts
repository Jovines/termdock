// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { assertNativeResumeAvailable, type NativeResumeOwnerCandidate, type NativeResumeProcess } from './nativeResumeOwner.js';

const target = { slug: 'fixture', nativeSessionId: 'original-uuid' };
const candidate: NativeResumeOwnerCandidate = { backendSessionId: 'other', cachedSlug: target.slug, cachedNativeId: target.nativeSessionId };
const observe = (value: NativeResumeProcess[]) => vi.fn(async () => value);

it('excludes the original backend even when it retains an old native binding', async () => {
  const probe = observe([{ confirmed: true, agentSlug: target.slug, nativeId: target.nativeSessionId }]);
  await assertNativeResumeAvailable(target, 'other', [candidate], probe);
  expect(probe).not.toHaveBeenCalled();
});
it('allows a stale UUID whose terminal has returned to the shell or disappeared', async () => {
  await assertNativeResumeAvailable(target, 'own', [candidate], observe([{ confirmed: true, agentSlug: null, nativeId: null }]));
  await assertNativeResumeAvailable(target, 'own', [candidate], observe([]));
});
it('uses actual native argv when the cached UUID names an old conversation', async () => {
  await assertNativeResumeAvailable(target, 'own', [candidate], observe([{ confirmed: true, agentSlug: target.slug, nativeId: 'different-uuid' }]));
});
it('rejects a proven live owner even when its cached identity is missing or different', async () => {
  const live = observe([{ confirmed: true, agentSlug: target.slug, nativeId: target.nativeSessionId }]);
  await expect(assertNativeResumeAvailable(target, 'own', [{ ...candidate, cachedNativeId: 'old' }], live))
    .rejects.toMatchObject({ code: 'NATIVE_SESSION_ALREADY_RUNNING' });
});
it('reports an uncertain possible owner without calling it running', async () => {
  for (const value of [
    [{ confirmed: false, agentSlug: null, nativeId: null }],
    [{ confirmed: true, agentSlug: target.slug, nativeId: null }],
  ]) await expect(assertNativeResumeAvailable(target, 'own', [candidate], observe(value)))
    .rejects.toMatchObject({ code: 'NATIVE_SESSION_OWNER_UNCONFIRMED' });
  await expect(assertNativeResumeAvailable(target, 'own', [candidate], async () => { throw new Error('ps unavailable'); }))
    .rejects.toMatchObject({ code: 'NATIVE_SESSION_OWNER_UNCONFIRMED' });
});
it('checks every observed pane and prefers a proven conflict over an uncertain one', async () => {
  const candidates = [candidate, { ...candidate, backendSessionId: 'third' }];
  await expect(assertNativeResumeAvailable(target, 'own', candidates, async item => item.backendSessionId === 'other'
    ? [{ confirmed: false, agentSlug: null, nativeId: null }]
    : [{ confirmed: true, agentSlug: null, nativeId: null }, { confirmed: true, agentSlug: target.slug, nativeId: target.nativeSessionId }]))
    .rejects.toMatchObject({ code: 'NATIVE_SESSION_ALREADY_RUNNING' });
});
