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
  resolvePackagedRuntime: vi.fn(() => ({
    serverRoot: '/runtime', cli: '/runtime/cli.js', version: '1.4.81', source: 'bundled',
  })),
  updateRuntimeFromRegistry: vi.fn(async (): Promise<any> => ({
    status: 'current',
    currentVersion: '1.4.81',
  })),
}));
const feedMock = vi.hoisted(() => ({
  buildGitHubUpdateFeed: vi.fn(async (): Promise<
    { status: 200; body: string } | { status: 204 }
  > => ({
    status: 200 as const,
    body: JSON.stringify({
      url: 'https://github.com/Jovines/termdock/releases/download/v1.4.82/update.zip',
    }),
  })),
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
  runtimeMock.resolvePackagedRuntime.mockReset().mockReturnValue({
    serverRoot: '/runtime', cli: '/runtime/cli.js', version: '1.4.81', source: 'bundled',
  });
  runtimeMock.updateRuntimeFromRegistry.mockReset().mockResolvedValue({
    status: 'current', currentVersion: '1.4.81',
  });
  feedMock.buildGitHubUpdateFeed.mockClear();
  feedMock.startGitHubUpdateFeedServer.mockClear();
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

  it('reports current directly when GitHub has no newer desktop release', async () => {
    feedMock.buildGitHubUpdateFeed.mockResolvedValueOnce({ status: 204 as const });
    const updater = await import('./updater.js');
    updater.configureDesktopUpdater(vi.fn(async () => ({ response: 0, checkboxChecked: false })));

    await expect(updater.checkForDesktopUpdates()).resolves.toMatchObject({
      status: 'current',
      currentVersion: '1.4.81',
      error: null,
    });
    expect(electronMock.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(feedMock.startGitHubUpdateFeedServer).not.toHaveBeenCalled();
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

  it('stages npm Runtime updates without invoking the desktop app updater', async () => {
    runtimeMock.updateRuntimeFromRegistry.mockResolvedValueOnce({
      status: 'updated', currentVersion: '1.4.82', latestVersion: '1.4.82',
    });
    const updater = await import('./updater.js');
    const states: string[] = [];
    updater.subscribeDesktopRuntimeUpdateState((state) => states.push(state.status));

    await expect(updater.checkForRuntimeUpdates()).resolves.toMatchObject({
      status: 'ready',
      currentVersion: '1.4.81',
      latestVersion: '1.4.82',
      source: 'desktop',
    });
    expect(runtimeMock.updateRuntimeFromRegistry).toHaveBeenCalledOnce();
    expect(electronMock.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(states).toEqual(['checking', 'ready']);
  });

  it('reports incompatible Runtime updates as requiring a desktop update', async () => {
    runtimeMock.updateRuntimeFromRegistry.mockResolvedValueOnce({
      status: 'requires-desktop',
      currentVersion: '1.4.81',
      latestVersion: '1.5.0',
      reason: 'Node 24 requires a desktop runtime rebuild',
    });
    const updater = await import('./updater.js');

    await expect(updater.checkForRuntimeUpdates()).resolves.toMatchObject({
      status: 'error',
      currentVersion: '1.4.81',
      latestVersion: '1.5.0',
      error: 'Node 24 requires a desktop runtime rebuild',
    });
  });

  it('leaves a failed Runtime restart retryable instead of stuck restarting', async () => {
    const updater = await import('./updater.js');

    updater.markDesktopRuntimeRestarting();
    expect(updater.getDesktopRuntimeUpdateState().status).toBe('restarting');

    expect(updater.markDesktopRuntimeRestartFailed(new Error('服务未能退出'))).toMatchObject({
      status: 'error',
      error: '服务未能退出',
    });
  });
});
