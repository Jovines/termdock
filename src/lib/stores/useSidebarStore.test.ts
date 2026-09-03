// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getSettingsMock, updateSettingsMock } = vi.hoisted(() => ({
  getSettingsMock: vi.fn(async () => ({ fileSortModes: {}, pinnedExplorerRoots: {} })),
  updateSettingsMock: vi.fn(async (settings: { fileSortModes?: Record<string, 'modified'>; fileSortMode?: { path: string; mode: 'name' | 'modified' }; pinnedExplorerRoots?: Record<string, Array<{ path: string; kind: 'file' | 'directory' }>>; pinnedExplorerRoot?: { rootPath: string; path: string; kind: 'file' | 'directory'; pinned: boolean } }) => ({
    fileSortModes: settings.fileSortModes ?? (settings.fileSortMode?.mode === 'modified' ? { [settings.fileSortMode.path]: 'modified' } : {}),
    pinnedExplorerRoots: settings.pinnedExplorerRoots ?? (settings.pinnedExplorerRoot?.pinned ? {
      [settings.pinnedExplorerRoot.rootPath]: [{
        path: settings.pinnedExplorerRoot.path,
        kind: settings.pinnedExplorerRoot.kind,
      }],
    } : {}),
  })),
}));

vi.mock('../terminal/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../terminal/api')>()),
  getSettings: getSettingsMock,
  updateSettings: updateSettingsMock,
}));
import {
  clampPinnedRightSidebarWidth,
  readLeftPinnedPreference,
  readRightSidebarLayoutPreference,
  readRightSidebarWidth,
  readRightSidebarWidthForContext,
  resolveRightSidebarNarrowLayout,
  useSidebarStore,
} from './useSidebarStore';

function resetSidebarStore(): void {
  useSidebarStore.setState({
    leftOpen: false,
    rightOpen: false,
    rightSidebarWidth: readRightSidebarWidth(),
    rightSidebarLayoutPreference: readRightSidebarLayoutPreference(),
    rightTab: 'files',
    rightSearchOpen: false,
    rootPath: null,
    contextKey: null,
    rightSidebarWidthContextKey: null,
    explorerRoot: null,
    explorerRootCache: {},
    pinnedExplorerRootsCache: {},
    pinnedExplorerRootsHydrated: true,
    expandedPaths: new Set(),
    selectedFilePath: null,
    directoryCache: new Map(),
    fileSortModes: {},
    fileSortModesHydrated: true,
    showHiddenFiles: false,
    changedFiles: new Map(),
    fileChangeVersions: new Map(),
    fileWatchEpoch: 0,
    gitBundleLoading: false,
    gitBundleSlow: false,
    gitBundleLoadingOwner: null,
    gitBundleError: null,
    gitBundleLastLoadedAt: null,
    gitBundleCacheInfo: null,
    projectStateCache: new Map(),
  });
}

describe('useSidebarStore right tab persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSidebarStore();
    getSettingsMock.mockClear();
    updateSettingsMock.mockClear();
  });

  afterEach(() => {
    window.localStorage.clear();
    resetSidebarStore();
  });

  it('persists the selected right sidebar tab per workspace root', () => {
    useSidebarStore.getState().setRootPath('/workspace/a');
    useSidebarStore.getState().setRightTab('git');

    useSidebarStore.getState().setRootPath('/workspace/b');
    expect(useSidebarStore.getState().rightTab).toBe('files');

    useSidebarStore.getState().setRightTab('diff');
    useSidebarStore.getState().setRootPath('/workspace/a');
    expect(useSidebarStore.getState().rightTab).toBe('git');

    useSidebarStore.getState().setRootPath('/workspace/b');
    expect(useSidebarStore.getState().rightTab).toBe('diff');
  });

  it('does not reuse the legacy global tab cache for a fresh workspace', () => {
    window.localStorage.setItem('termdock:right-sidebar:tab:v1', JSON.stringify('git'));

    useSidebarStore.getState().setRootPath('/workspace/fresh');

    expect(useSidebarStore.getState().rightTab).toBe('files');
  });
});

describe('useSidebarStore Git bundle loading ownership', () => {
  beforeEach(() => resetSidebarStore());

  afterEach(() => resetSidebarStore());

  it('does not let a remounted sidebar request clear the current loading state', () => {
    const store = useSidebarStore.getState();
    store.beginGitBundleLoading('old-sidebar:1');
    store.resetGitBundleLoading();
    store.beginGitBundleLoading('new-sidebar:1');

    useSidebarStore.getState().finishGitBundleLoading('old-sidebar:1');

    expect(useSidebarStore.getState()).toMatchObject({
      gitBundleLoading: true,
      gitBundleSlow: false,
      gitBundleLoadingOwner: 'new-sidebar:1',
    });
  });

  it('clears loading only when the active request finishes', () => {
    const store = useSidebarStore.getState();
    store.beginGitBundleLoading('sidebar:2');
    store.setGitBundleSlowFor('sidebar:2', true);
    store.finishGitBundleLoading('sidebar:2');

    expect(useSidebarStore.getState()).toMatchObject({
      gitBundleLoading: false,
      gitBundleSlow: false,
      gitBundleLoadingOwner: null,
    });
  });
});

describe('pinned right sidebar width', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSidebarStore();
  });

  afterEach(() => {
    window.localStorage.clear();
    resetSidebarStore();
  });

  it('uses the viewport and terminal minimum width instead of a fixed desktop cap', () => {
    expect(clampPinnedRightSidebarWidth(2_400, 2_560, 300)).toBe(1_970);
    expect(clampPinnedRightSidebarWidth(1_000, 1_440, 300)).toBe(850);
  });

  it('keeps the right sidebar minimum when desktop space is constrained', () => {
    expect(clampPinnedRightSidebarWidth(100, 1_024, 300)).toBe(320);
  });

  it('persists widths beyond the previous 760px limit', () => {
    useSidebarStore.getState().setRightSidebarWidth(1_200);
    expect(useSidebarStore.getState().rightSidebarWidth).toBe(1_200);
    expect(readRightSidebarWidth()).toBe(1_200);
  });

  it('persists and restores the pinned width for each session', () => {
    useSidebarStore.getState().setRootPath('/workspace/shared', 'session-a');
    useSidebarStore.getState().setRightSidebarWidth(640);

    useSidebarStore.getState().setRootPath('/workspace/shared', 'session-b');
    expect(useSidebarStore.getState().rightSidebarWidth).toBe(760);
    useSidebarStore.getState().setRightSidebarWidth(920);

    useSidebarStore.getState().setRootPath('/workspace/shared', 'session-a');
    expect(useSidebarStore.getState().rightSidebarWidth).toBe(640);

    useSidebarStore.getState().setRootPath('/workspace/shared', 'session-b');
    expect(useSidebarStore.getState().rightSidebarWidth).toBe(920);
  });

  it('restores a session width from local storage after the in-memory state is reset', () => {
    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a');
    useSidebarStore.getState().setRightSidebarWidth(880);

    resetSidebarStore();
    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a');

    expect(useSidebarStore.getState().rightSidebarWidth).toBe(880);
  });

  it('reads inactive session and split widths without changing the active context', () => {
    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a');
    useSidebarStore.getState().setRightSidebarWidth(640);
    useSidebarStore.getState().setRootPath('/workspace/b', 'session-b');
    useSidebarStore.getState().setRightSidebarWidth(920);
    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a', 'split-group-1');
    useSidebarStore.getState().setRightSidebarWidth(780);

    expect(readRightSidebarWidthForContext('session-a', '/workspace/a', null)).toBe(640);
    expect(readRightSidebarWidthForContext('session-b', '/workspace/b', null)).toBe(920);
    expect(readRightSidebarWidthForContext('session-a', '/workspace/a', 'split-group-1')).toBe(780);
    expect(useSidebarStore.getState().rightSidebarWidth).toBe(780);
  });

  it('shares the pinned width between sessions in the same split workspace', () => {
    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a', 'split-group-1');
    expect(useSidebarStore.getState().rightSidebarWidth).toBe(760);
    useSidebarStore.getState().setRightSidebarWidth(680);

    useSidebarStore.getState().setRootPath('/workspace/b', 'session-b', 'split-group-1');
    expect(useSidebarStore.getState().rightSidebarWidth).toBe(680);

    useSidebarStore.getState().setRightSidebarWidth(940);
    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a', 'split-group-1');
    expect(useSidebarStore.getState().rightSidebarWidth).toBe(940);
  });

  it('keeps split workspace widths separate from sessions and other split workspaces', () => {
    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a');
    useSidebarStore.getState().setRightSidebarWidth(620);

    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a', 'split-group-1');
    expect(useSidebarStore.getState().rightSidebarWidth).toBe(620);
    useSidebarStore.getState().setRightSidebarWidth(860);

    useSidebarStore.getState().setRootPath('/workspace/c', 'session-c', 'split-group-2');
    expect(useSidebarStore.getState().rightSidebarWidth).toBe(760);

    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a');
    expect(useSidebarStore.getState().rightSidebarWidth).toBe(620);
  });

  it('prefers an existing split workspace width when a session rejoins it', () => {
    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a', 'split-group-1');
    useSidebarStore.getState().setRightSidebarWidth(900);

    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a');
    useSidebarStore.getState().setRightSidebarWidth(640);
    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a', 'split-group-1');

    expect(useSidebarStore.getState().rightSidebarWidth).toBe(900);
  });

  it('copies the final split width to every session that leaves the group', () => {
    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a');
    useSidebarStore.getState().setRightSidebarWidth(610);
    useSidebarStore.getState().setRootPath('/workspace/b', 'session-b');
    useSidebarStore.getState().setRightSidebarWidth(720);

    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a', 'split-group-1');
    useSidebarStore.getState().setRightSidebarWidth(930);
    useSidebarStore.getState().inheritRightSidebarStateFromSplitWorkspace('split-group-1', [
      { sessionId: 'session-a', rootPath: '/workspace/a' },
      { sessionId: 'session-b', rootPath: '/workspace/b' },
    ]);

    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a');
    expect(useSidebarStore.getState().rightSidebarWidth).toBe(930);
    useSidebarStore.getState().setRootPath('/workspace/b', 'session-b');
    expect(useSidebarStore.getState().rightSidebarWidth).toBe(930);
  });
});

describe('split-workspace right sidebar state', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSidebarStore();
  });

  afterEach(() => {
    window.localStorage.clear();
    resetSidebarStore();
  });

  it('shares content state between every session in a split workspace', () => {
    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a');
    useSidebarStore.getState().setRightTab('diff');
    useSidebarStore.getState().setExplorerRoot('/workspace/a/docs');
    useSidebarStore.getState().toggleExpanded('/workspace/a/docs');
    useSidebarStore.getState().selectFile('/workspace/a/docs/a.md');

    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a', 'split-group-1');
    useSidebarStore.getState().setRootPath('/workspace/b', 'session-b', 'split-group-1');

    expect(useSidebarStore.getState()).toMatchObject({
      rightTab: 'diff',
      explorerRoot: '/workspace/a/docs',
      selectedFilePath: '/workspace/a/docs/a.md',
    });
    expect(useSidebarStore.getState().expandedPaths).toEqual(new Set(['/workspace/a/docs']));
  });

  it('restores the shared split content state after an in-memory reset', () => {
    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a');
    useSidebarStore.getState().setRightTab('diff');
    useSidebarStore.getState().setExplorerRoot('/workspace/a/docs');
    useSidebarStore.getState().selectFile('/workspace/a/docs/a.md');
    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a', 'split-group-1');

    resetSidebarStore();
    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a', 'split-group-1');

    expect(useSidebarStore.getState()).toMatchObject({
      rightTab: 'diff',
      explorerRoot: '/workspace/a/docs',
      selectedFilePath: '/workspace/a/docs/a.md',
    });
  });

  it('copies the final split content state to sessions when the group is dissolved', () => {
    useSidebarStore.getState().setRootPath('/workspace/a', 'session-a', 'split-group-1');
    useSidebarStore.getState().setRightTab('git');
    useSidebarStore.getState().setExplorerRoot('/workspace/shared');
    useSidebarStore.getState().toggleExpanded('/workspace/shared/src');
    useSidebarStore.getState().selectFile('/workspace/shared/src/index.ts');

    useSidebarStore.getState().inheritRightSidebarStateFromSplitWorkspace('split-group-1', [
      { sessionId: 'session-a', rootPath: '/workspace/a' },
      { sessionId: 'session-b', rootPath: '/workspace/b' },
    ]);

    for (const [sessionId, rootPath] of [
      ['session-a', '/workspace/a'],
      ['session-b', '/workspace/b'],
    ] as const) {
      useSidebarStore.getState().setRootPath(rootPath, sessionId);
      expect(useSidebarStore.getState()).toMatchObject({
        rightTab: 'git',
        explorerRoot: '/workspace/shared',
        selectedFilePath: '/workspace/shared/src/index.ts',
      });
      expect(useSidebarStore.getState().expandedPaths).toEqual(new Set(['/workspace/shared/src']));
    }
  });
});

describe('useSidebarStore session-scoped right sidebar state', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSidebarStore();
  });

  afterEach(() => {
    window.localStorage.clear();
    resetSidebarStore();
  });

  it('keeps open file, explorer root, expansion, and tab separate for sessions in the same directory', () => {
    useSidebarStore.getState().setRootPath('/workspace/shared', 'session-a');
    useSidebarStore.getState().setRightTab('diff');
    useSidebarStore.getState().setExplorerRoot('/workspace/shared/docs');
    useSidebarStore.getState().toggleExpanded('/workspace/shared/docs');
    useSidebarStore.getState().selectFile('/workspace/shared/docs/a.md');

    useSidebarStore.getState().setRootPath('/workspace/shared', 'session-b');
    expect(useSidebarStore.getState().rightTab).toBe('files');
    expect(useSidebarStore.getState().explorerRoot).toBe('/workspace/shared');
    expect(useSidebarStore.getState().expandedPaths.size).toBe(0);
    expect(useSidebarStore.getState().selectedFilePath).toBeNull();

    useSidebarStore.getState().setExplorerRoot('/workspace/shared/src');
    useSidebarStore.getState().selectFile('/workspace/shared/src/b.ts');
    useSidebarStore.getState().setRootPath('/workspace/shared', 'session-a');

    expect(useSidebarStore.getState().rightTab).toBe('diff');
    expect(useSidebarStore.getState().explorerRoot).toBe('/workspace/shared/docs');
    expect(useSidebarStore.getState().expandedPaths).toEqual(new Set(['/workspace/shared/docs']));
    expect(useSidebarStore.getState().selectedFilePath).toBe('/workspace/shared/docs/a.md');
  });

  it('continues sharing pinned entries between sessions in the same directory', async () => {
    useSidebarStore.getState().setRootPath('/workspace/shared', 'session-a');
    useSidebarStore.getState().pinExplorerRoot('/workspace/shared/README.md', 'file');

    useSidebarStore.getState().setRootPath('/workspace/shared', 'session-b');

    expect(useSidebarStore.getState().pinnedExplorerRootsCache['/workspace/shared']).toEqual([
      { path: '/workspace/shared/README.md', kind: 'file' },
    ]);
    await vi.waitFor(() => expect(updateSettingsMock).toHaveBeenCalledWith(expect.objectContaining({
      pinnedExplorerRoot: {
        rootPath: '/workspace/shared',
        path: '/workspace/shared/README.md',
        kind: 'file',
        pinned: true,
      },
    })));
  });

  it('hydrates pinned entries from the server and removes the legacy browser cache', async () => {
    getSettingsMock.mockResolvedValueOnce({
      fileSortModes: {},
      pinnedExplorerRoots: {
        '/workspace/shared': [{ path: '/workspace/shared/docs', kind: 'directory' }],
      },
    });
    window.localStorage.setItem('termdock:right-sidebar:pinned-explorer-roots:v1', JSON.stringify({
      '/workspace/local': [{ path: '/workspace/local/tmp', kind: 'directory' }],
    }));
    useSidebarStore.setState({ pinnedExplorerRootsHydrated: false });

    await useSidebarStore.getState().hydratePinnedExplorerRoots();

    expect(useSidebarStore.getState().pinnedExplorerRootsCache).toEqual({
      '/workspace/shared': [{ path: '/workspace/shared/docs', kind: 'directory' }],
    });
    expect(useSidebarStore.getState().pinnedExplorerRootsHydrated).toBe(true);
    expect(window.localStorage.getItem('termdock:right-sidebar:pinned-explorer-roots:v1')).toBeNull();
  });

  it('migrates legacy browser pins when the server has no pin list yet', async () => {
    const localRoots = {
      '/workspace/local': [{ path: '/workspace/local/docs', kind: 'directory' as const }],
    };
    useSidebarStore.setState({
      pinnedExplorerRootsCache: localRoots,
      pinnedExplorerRootsHydrated: false,
    });

    await useSidebarStore.getState().hydratePinnedExplorerRoots();

    expect(updateSettingsMock).toHaveBeenCalledWith(expect.objectContaining({ pinnedExplorerRoots: localRoots }));
    expect(useSidebarStore.getState().pinnedExplorerRootsCache).toEqual(localRoots);
  });
});

describe('useSidebarStore left sidebar pin preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSidebarStore();
  });

  afterEach(() => {
    window.localStorage.clear();
    resetSidebarStore();
  });

  it('pins the desktop session navigator on first use', () => {
    expect(readLeftPinnedPreference()).toBe(true);
  });

  it('preserves an explicit unpin choice', () => {
    useSidebarStore.getState().setLeftPinned(false);

    expect(window.localStorage.getItem('termdock-left-sidebar-pinned')).toBe('0');
    expect(readLeftPinnedPreference()).toBe(false);
  });

  it('preserves an explicit pin choice', () => {
    useSidebarStore.getState().setLeftPinned(true);

    expect(window.localStorage.getItem('termdock-left-sidebar-pinned')).toBe('1');
    expect(readLeftPinnedPreference()).toBe(true);
  });
});

describe('useSidebarStore right sidebar width', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('starts wide enough for the desktop split workspace', () => {
    expect(readRightSidebarWidth()).toBe(760);
  });

  it('preserves a user-resized narrow width for responsive sidebar layout', () => {
    window.localStorage.setItem('termdock-right-sidebar-width', '520');
    expect(readRightSidebarWidth()).toBe(520);
  });
});

describe('useSidebarStore right sidebar layout preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSidebarStore();
  });

  afterEach(() => {
    window.localStorage.clear();
    resetSidebarStore();
  });

  it('defaults to automatic layout and persists explicit choices', () => {
    expect(readRightSidebarLayoutPreference()).toBe('auto');

    useSidebarStore.getState().setRightSidebarLayoutPreference('narrow');

    expect(readRightSidebarLayoutPreference()).toBe('narrow');
    expect(window.localStorage.getItem('termdock-right-sidebar-layout-preference')).toBe('narrow');
  });

  it('only overrides the width breakpoint for pinned desktop sidebars', () => {
    expect(resolveRightSidebarNarrowLayout(520, true, 'auto')).toBe(true);
    expect(resolveRightSidebarNarrowLayout(760, true, 'narrow')).toBe(true);
    expect(resolveRightSidebarNarrowLayout(520, true, 'wide')).toBe(false);
    expect(resolveRightSidebarNarrowLayout(520, false, 'wide')).toBe(true);
  });
});

describe('useSidebarStore file watch epoch', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSidebarStore();
  });

  afterEach(() => {
    window.localStorage.clear();
    resetSidebarStore();
  });

  it('bumps the global epoch on rescan-required', () => {
    useSidebarStore.getState().setRootPath('/workspace/a');
    useSidebarStore.getState().selectFile('/workspace/a/notes.md');

    useSidebarStore.getState().applyFileWatchEvents([{ type: 'rescan-required', path: '/workspace/a' }]);

    const state = useSidebarStore.getState();
    expect(state.fileWatchEpoch).toBe(1);
    // Selected file keeps its per-path bump for path-only subscribers.
    expect(state.fileChangeVersions.get('/workspace/a/notes.md')).toBe(1);
  });

  it('bumpFileWatchEpoch increments monotonically', () => {
    useSidebarStore.getState().bumpFileWatchEpoch();
    useSidebarStore.getState().bumpFileWatchEpoch();

    expect(useSidebarStore.getState().fileWatchEpoch).toBe(2);
  });

  it('does not touch the epoch for regular updated events', () => {
    useSidebarStore.getState().applyFileWatchEvents([{ type: 'updated', path: '/workspace/a/img.png' }]);

    const state = useSidebarStore.getState();
    expect(state.fileWatchEpoch).toBe(0);
    expect(state.fileChangeVersions.get('/workspace/a/img.png')).toBe(1);
  });
});

describe('useSidebarStore per-directory file sorting', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSidebarStore();
    getSettingsMock.mockClear();
    updateSettingsMock.mockClear();
  });

  afterEach(() => {
    window.localStorage.clear();
    resetSidebarStore();
  });

  it('keeps recent sorting scoped to one directory and reorders watcher updates', async () => {
    useSidebarStore.setState({
      directoryCache: new Map([['/workspace/logs', [
        { name: 'older.log', path: '/workspace/logs/older.log', type: 'file', modified: '2026-01-01T00:00:00.000Z' },
      ]]]),
    });
    await useSidebarStore.getState().setDirectorySortMode('/workspace/logs', 'modified');
    useSidebarStore.getState().setDirectoryCache('/workspace/logs', [
      { name: 'older.log', path: '/workspace/logs/older.log', type: 'file', modified: '2026-01-01T00:00:00.000Z' },
    ]);

    useSidebarStore.getState().applyFileWatchEvents([{
      type: 'created',
      path: '/workspace/logs/newer.log',
      entry: { name: 'newer.log', path: '/workspace/logs/newer.log', type: 'file', modified: '2026-08-31T00:00:00.000Z' },
    }]);

    expect(useSidebarStore.getState().directoryCache.get('/workspace/logs')?.map((entry) => entry.name)).toEqual([
      'newer.log',
      'older.log',
    ]);
    expect(useSidebarStore.getState().fileSortModes['/workspace']).toBeUndefined();
    expect(updateSettingsMock).toHaveBeenCalledWith({
      fileSortMode: { path: '/workspace/logs', mode: 'modified' },
    });
  });

  it('hydrates the server preference as the source of truth', async () => {
    getSettingsMock.mockResolvedValueOnce({ fileSortModes: { '/workspace/archive': 'modified' } });
    useSidebarStore.setState({
      fileSortModes: { '/workspace/local-only': 'modified' },
      fileSortModesHydrated: false,
      directoryCache: new Map([['/workspace', []]]),
    });

    await useSidebarStore.getState().hydrateFileSortModes();

    expect(useSidebarStore.getState().fileSortModes).toEqual({ '/workspace/archive': 'modified' });
    expect(useSidebarStore.getState().fileSortModesHydrated).toBe(true);
    expect(useSidebarStore.getState().directoryCache.size).toBe(0);
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('migrates legacy local preferences when the server has none', async () => {
    getSettingsMock.mockResolvedValueOnce({ fileSortModes: {} });
    updateSettingsMock.mockResolvedValueOnce({ fileSortModes: { '/workspace/legacy': 'modified' } });
    useSidebarStore.setState({
      fileSortModes: { '/workspace/legacy': 'modified' },
      fileSortModesHydrated: false,
    });

    await useSidebarStore.getState().hydrateFileSortModes();

    expect(updateSettingsMock).toHaveBeenCalledWith({
      fileSortModes: { '/workspace/legacy': 'modified' },
    });
    expect(useSidebarStore.getState().fileSortModes).toEqual({ '/workspace/legacy': 'modified' });
  });
});
