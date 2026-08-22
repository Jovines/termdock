import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const autoUpdater = {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
      return autoUpdater;
    }),
  };
  return {
    app: {
      isPackaged: true,
      getVersion: vi.fn(() => '1.4.81'),
    },
    autoUpdater,
    emit(event: string, ...args: any[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    reset() {
      listeners.clear();
      autoUpdater.setFeedURL.mockClear();
      autoUpdater.checkForUpdates.mockClear();
      autoUpdater.quitAndInstall.mockClear();
      autoUpdater.on.mockClear();
    },
  };
});

const runtimeMock = vi.hoisted(() => ({
  updateRuntimeFromRegistry: vi.fn(async () => ({
    status: 'current',
    currentVersion: '1.4.81',
  })),
}));
const feedMock = vi.hoisted(() => ({
  startGitHubUpdateFeedServer: vi.fn(async () => ({
    url: 'http://127.0.0.1:54321/feed',
    close: vi.fn(),
  })),
}));

vi.mock('electron', () => ({
  app: electronMock.app,
  autoUpdater: electronMock.autoUpdater,
}));
vi.mock('./runtime.js', () => runtimeMock);
vi.mock('./githubUpdateFeed.js', () => feedMock);

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  electronMock.reset();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('desktop updater', () => {
  it('checks the desktop feed even when the npm runtime is already current', async () => {
    const updater = await import('./updater.js');
    updater.configureDesktopUpdater(vi.fn(async () => ({ response: 0, checkboxChecked: false })));

    const check = updater.checkForDesktopUpdates();
    await vi.waitFor(() => expect(electronMock.autoUpdater.checkForUpdates).toHaveBeenCalledOnce());
    expect(electronMock.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:54321/feed',
    });
    expect(runtimeMock.updateRuntimeFromRegistry).not.toHaveBeenCalled();

    electronMock.emit('update-not-available');
    await expect(check).resolves.toMatchObject({
      status: 'current',
      currentVersion: '1.4.81',
    });
  });

  it('publishes download state and installs only after the desktop update is ready', async () => {
    const updater = await import('./updater.js');
    updater.configureDesktopUpdater(vi.fn(async () => ({ response: 1, checkboxChecked: false })));
    const states: string[] = [];
    updater.subscribeDesktopUpdateState((state) => states.push(state.status));

    const check = updater.checkForDesktopUpdates();
    await vi.waitFor(() => expect(electronMock.autoUpdater.checkForUpdates).toHaveBeenCalledOnce());
    electronMock.emit('update-available');
    await expect(check).resolves.toMatchObject({ status: 'downloading' });

    electronMock.emit('update-downloaded', {}, '', 'Termdock v1.4.82', new Date(), '');
    expect(updater.getDesktopUpdateState()).toMatchObject({
      status: 'ready',
      latestVersion: '1.4.82',
    });
    expect(() => updater.installDownloadedDesktopUpdate()).not.toThrow();
    expect(electronMock.autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
    expect(states).toContain('downloading');
    expect(states).toContain('ready');
    expect(states).toContain('installing');
  });
});
