// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLeftPinnedPreference, useSidebarStore } from './useSidebarStore';

function resetSidebarStore(): void {
  useSidebarStore.setState({
    leftOpen: false,
    rightOpen: false,
    rightTab: 'files',
    rightSearchOpen: false,
    rootPath: null,
    explorerRoot: null,
    explorerRootCache: {},
    pinnedExplorerRootsCache: {},
    expandedPaths: new Set(),
    selectedFilePath: null,
    directoryCache: new Map(),
    showHiddenFiles: false,
    changedFiles: new Map(),
    fileChangeVersions: new Map(),
    fileWatchEpoch: 0,
    gitBundleLoading: false,
    gitBundleSlow: false,
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
