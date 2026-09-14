// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWorkspaceHost } from './workspaceHost';
import { writeBrowserServices, type ServiceConnection } from './serviceDirectory';
import { scopedStorageKey, TARGET_KEY } from '../federation/clientScope';

const lastWorkspace = 'termdock-secure-last-workspace';
const entry: ServiceConnection = { id: 'entry', targetPeerId: 'entry', url: 'https://entry.example', label: 'Entry' };
const remote: ServiceConnection = {
  id: 'remote', targetPeerId: 'remote', url: 'https://remote.internal', label: 'Remote',
  routes: [{ url: entry.url, targetPeerId: 'entry' }],
};
function restart(cold = false) {
  delete window.__termdockWorkspaceHost;
  if (cold) sessionStorage.clear();
  return installWorkspaceHost(entry)!;
}

describe('PWA workspace selection restore', () => {
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear();
    delete window.__termdockWorkspaceHost;
    writeBrowserServices([entry, remote]);
  });
  afterEach(() => { vi.restoreAllMocks(); delete window.__termdockWorkspaceHost; });

  it('restores the switched service and its relay routes after a cold launch without a worker', () => {
    localStorage.setItem(TARGET_KEY, JSON.stringify(entry));
    expect(installWorkspaceHost(entry)!.activate(remote)).toBe(true);
    const host = restart(true);
    expect(host.snapshot().activeKey).toBe('remote');
    expect(host.snapshot().items.find(item => item.key === 'remote')?.service).toEqual(remote);
    expect(JSON.parse(localStorage.getItem(TARGET_KEY)!)).toEqual(entry);
    expect(scopedStorageKey(lastWorkspace, 'entry')).toBe(lastWorkspace);
    expect(scopedStorageKey(lastWorkspace, 'remote')).toBe(lastWorkspace);
  });

  it('remembers switching back to the entry service', () => {
    const host = installWorkspaceHost(entry)!;
    host.activate(remote); host.activate(entry);
    expect(restart(true).snapshot().activeKey).toBe('root');
    expect(localStorage.getItem(lastWorkspace)).toBe('entry');
  });

  it('keeps a tab selection on reload when another tab changes the durable selection', () => {
    installWorkspaceHost(entry)!.activate(remote);
    localStorage.setItem(lastWorkspace, 'entry');
    expect(restart().snapshot().activeKey).toBe('remote');
  });

  it('does not let background reports or a failed connection overwrite the active service', () => {
    const host = installWorkspaceHost(entry)!;
    host.activate(remote);
    host.report('root', { service: entry, phase: 'ready' });
    host.report('remote', { phase: 'offline' });
    expect(restart(true).snapshot().activeKey).toBe('remote');
  });

  it('falls back to the entry when the remembered service has been removed', () => {
    installWorkspaceHost(entry)!.activate(remote);
    writeBrowserServices([entry]);
    expect(restart(true).snapshot().activeKey).toBe('root');
  });

  it.each(['sessionStorage', 'localStorage'] as const)('still saves and restores when %s is unavailable', unavailable => {
    const blocked = window[unavailable];
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (this === blocked && key === lastWorkspace) throw new Error('Storage denied');
      return get.call(this, key);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (this === blocked && key === lastWorkspace) throw new Error('Storage denied');
      return set.call(this, key, value);
    });
    expect(installWorkspaceHost(entry)!.activate(remote)).toBe(true);
    expect(restart(unavailable === 'sessionStorage').snapshot().activeKey).toBe('remote');
  });
});
