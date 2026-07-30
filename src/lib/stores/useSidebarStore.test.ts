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
