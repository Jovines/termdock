// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { scopedStorageKey, TARGET_KEY, migrateLegacyServiceState } from './clientScope';
describe('service state isolation', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
  it('separates identical session and filesystem cache keys by stable service identity', () => {
    expect(scopedStorageKey('terminal-state', 'B')).not.toBe(scopedStorageKey('terminal-state', 'C'));
    expect(scopedStorageKey('explorer-/workspace', 'B')).not.toBe(scopedStorageKey('explorer-/workspace', 'C'));
  });
  it('keeps device preferences and explicitly paired directory global', () => {
    expect(scopedStorageKey(TARGET_KEY, 'B')).toBe(TARGET_KEY);
    expect(scopedStorageKey('termdock-color-theme', 'C')).toBe('termdock-color-theme');
    expect(scopedStorageKey('termdock.federation.connections.v1', 'C')).toBe('termdock.federation.connections.v1');
  });
  it('preserves legacy tabs only for the first verified direct service without reviving deleted state', () => {
    localStorage.setItem('terminal-state', 'existing-tabs');
    sessionStorage.setItem('active-terminal', 'one');
    migrateLegacyServiceState('B');
    expect(localStorage.getItem(scopedStorageKey('terminal-state', 'B'))).toBe('existing-tabs');
    expect(sessionStorage.getItem(scopedStorageKey('active-terminal', 'B'))).toBe('one');
    migrateLegacyServiceState('C');
    expect(localStorage.getItem(scopedStorageKey('terminal-state', 'C'))).toBeNull();
    localStorage.removeItem(scopedStorageKey('terminal-state', 'B'));
    migrateLegacyServiceState('B');
    expect(localStorage.getItem(scopedStorageKey('terminal-state', 'B'))).toBeNull();
  });
});
