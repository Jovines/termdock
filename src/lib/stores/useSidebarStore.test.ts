// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLeftPinnedPreference, readRightSidebarWidth, useSidebarStore } from './useSidebarStore';

function resetSidebarStore(): void {
  useSidebarStore.setState({
    leftOpen: false,
    rightOpen: false,
    rightTab: 'files',
    rightSearchOpen: false,
    rootPath: null,
    contextKey: null,
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
    useSidebarStore.getState().setRightTab('file');
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

    expect(useSidebarStore.getState().rightTab).toBe('file');
    expect(useSidebarStore.getState().explorerRoot).toBe('/workspace/shared/docs');
    expect(useSidebarStore.getState().expandedPaths).toEqual(new Set(['/workspace/shared/docs']));
    expect(useSidebarStore.getState().selectedFilePath).toBe('/workspace/shared/docs/a.md');
  });

  it('continues sharing pinned entries between sessions in the same directory', () => {
    useSidebarStore.getState().setRootPath('/workspace/shared', 'session-a');
    useSidebarStore.getState().pinExplorerRoot('/workspace/shared/README.md', 'file');

    useSidebarStore.getState().setRootPath('/workspace/shared', 'session-b');

    expect(useSidebarStore.getState().pinnedExplorerRootsCache['/workspace/shared']).toEqual([
      { path: '/workspace/shared/README.md', kind: 'file' },
    ]);
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
