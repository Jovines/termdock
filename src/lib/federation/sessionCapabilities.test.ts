import { expect, it } from 'vitest';
import { sharedResourceTabs, sharedSessionCapabilities } from './sessionCapabilities';
it('starts shared access empty and enables only explicitly granted session capabilities', () => {
  expect([...sharedSessionCapabilities(undefined)]).toEqual([]);
  expect([...sharedSessionCapabilities({})]).toEqual(['session.view']);
  expect([...sharedSessionCapabilities({ canWrite: true, canResize: true })]).toEqual(['session.view', 'session.input', 'session.resize']);
  expect([...sharedSessionCapabilities({ canWrite: 'true', canResize: 1 } as never)]).toEqual(['session.view']);
});
it('does not inherit owner or newly added capabilities from writable shares', () => {
  const capabilities = sharedSessionCapabilities({ canWrite: true, canResize: true, 'service:*': true, 'todo.guidance': true } as never);
  for (const capability of ['session.owner-menu', 'session.share', 'todo.guidance', 'future.feature', 'service:*']) expect(capabilities.has(capability as never)).toBe(false);
});
it('opens only named resource kinds in the shared resource grant', () => {
  const resources = { android: [{ serial: 'fixture', access: 'view' as const }], directories: [{ path: '/shared', access: 'read' as const }], future: [{}] };
  expect(sharedResourceTabs(resources)).toEqual(['android', 'files']);
  expect([...sharedSessionCapabilities(undefined, resources)]).toEqual(['resource.android', 'resource.files']);
});
