import { expect, it } from 'vitest';
import { SessionSharingPresence } from './sessionSharing';
import type { AuthorizationGrant } from './authorization';
it('counts connected devices rather than tabs and removes closed connections', () => {
  const presence = new SessionSharingPresence();
  const grant = { subjectId: 'phone', scope: { kind: 'sessions', sessionIds: ['backend'] } } as AuthorizationGrant;
  presence.visit('tab1', 'phone', 'session'); presence.visit('tab2', 'phone', 'session');
  const summary = () => presence.summary([grant], [], id => id === 'backend' ? 'session' : id)[0];
  expect(summary().connectedDevices).toBe(1); presence.close('tab1'); expect(summary().connectedDevices).toBe(1); presence.close('tab2'); expect(summary().connectedDevices).toBe(0);
});
