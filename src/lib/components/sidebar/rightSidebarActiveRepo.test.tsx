// @vitest-environment jsdom
//
// Restoring the selected sub-repo end to end: the choice is keyed by context
// key, mirrored server-side, and only valid once the workspace bundle that
// lists its repositories has been read.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { getGitBundle, type GitBundleResponse, type GitRepositoryBundle } from '../../terminal/api';
import { RightSidebar, replaceGitRepositorySnapshot } from './RightSidebar';
import type { ReactNode } from 'react';

vi.mock('./Sidebar', () => ({ Sidebar: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

const { getSettingsMock, updateSettingsMock } = vi.hoisted(() => ({
  getSettingsMock: vi.fn(),
  updateSettingsMock: vi.fn(async () => ({})),
}));

vi.mock('../../terminal/api', async (original) => ({
  ...await original<typeof import('../../terminal/api')>(),
  getGitBundle: vi.fn(),
  getSettings: getSettingsMock,
  updateSettings: updateSettingsMock,
}));

const WORKSPACE = '/workspace/app';
const NESTED = '/workspace/app/vendor/lib';
const CONTEXT_KEY = `session-1${String.fromCharCode(0)}${WORKSPACE}`;
const OTHER_CONTEXT_KEY = `session-2${String.fromCharCode(0)}${WORKSPACE}`;

const workspaceRepository = (files: GitBundleResponse['files'] = []) => ({
  id: 'repo-workspace',
  root: WORKSPACE,
  relativeRoot: '',
  name: 'app',
  depth: 0,
  nested: false,
  available: true,
  files,
  context: { available: true, root: WORKSPACE, branch: 'main' },
});

const nestedRepository = (deferred: boolean) => ({
  id: 'repo-nested',
  root: NESTED,
  relativeRoot: 'vendor/lib',
  name: 'lib',
  depth: 1,
  nested: true,
  available: true,
  files: deferred ? [] : [nestedFile],
  context: deferred ? null : { available: true, root: NESTED, branch: 'main' },
  ...(deferred ? { deferred: true } : {}),
});

const nestedFile = {
  path: 'a.ts',
  absolutePath: `${NESTED}/a.ts`,
  repoRoot: NESTED,
  status: 'modified' as const,
  staged: false,
  unstaged: true,
  untracked: false,
  tracked: true,
  canStage: true,
  canUnstage: false,
  canStash: true,
  canRestoreWorktree: true,
};

// What the discovery-only pass returns: the nested repo is listed, but its
// files were never read.
const discoveryBundle: GitBundleResponse = {
  available: true,
  files: [],
  context: { available: true, root: WORKSPACE, branch: 'main' },
  repositories: [workspaceRepository(), nestedRepository(true)],
  repoFilters: [
    { root: WORKSPACE, label: 'app', count: 0, staged: 0 },
    { root: NESTED, label: 'lib', count: 2, staged: 0, deferred: true },
  ],
  nestedDeferred: true,
};

const nestedBundle: GitBundleResponse = {
  available: true,
  files: [nestedFile],
  context: { available: true, root: NESTED, branch: 'main' },
  repositories: [nestedRepository(false)],
  repoFilters: [{ root: NESTED, label: 'lib', count: 1, staged: 0 }],
};

const initialState = useSidebarStore.getState();
const sidebar = () => (
  <I18nProvider><RightSidebar isOpen drawerWidthPx={400} onClose={() => {}} /></I18nProvider>
);

// Regression: a single-repo bundle carries no `deferred` key, so merging one
// over a discovery placeholder left the flag set. The chip then read "not
// loaded" forever, and the lazy-load path could not tell a repo waiting to be
// fetched from one already fetched.
describe('replaceGitRepositorySnapshot', () => {
  it('clears the placeholder flag once the repo has been read', () => {
    const placeholder: GitRepositoryBundle = {
      id: 'repo-nested',
      root: NESTED,
      relativeRoot: 'vendor/lib',
      name: 'lib',
      depth: 1,
      nested: true,
      available: true,
      files: [],
      context: null,
      deferred: true,
    };

    const { repositories } = replaceGitRepositorySnapshot([], [placeholder], nestedBundle, NESTED, WORKSPACE);

    expect(repositories).toHaveLength(1);
    expect(repositories[0].deferred).toBe(false);
    expect(repositories[0].files.map((file) => file.absolutePath)).toEqual([nestedFile.absolutePath]);
  });
});

describe('restoring the selected sub-repo', () => {
  let bundles: Array<(bundle: GitBundleResponse) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    bundles = [];
    vi.mocked(getGitBundle).mockReset();
    vi.mocked(getGitBundle).mockImplementation(() => new Promise((resolve) => { bundles.push(resolve); }));
    getSettingsMock.mockReset();
    getSettingsMock.mockResolvedValue({
      nestedGitScanRoots: { [WORKSPACE]: true },
      activeGitRepos: { [CONTEXT_KEY]: NESTED },
    });
    updateSettingsMock.mockClear();
    useSidebarStore.setState({
      ...initialState,
      rootPath: WORKSPACE,
      contextKey: CONTEXT_KEY,
      rightTab: 'diff',
      nestedGitScanRoots: { [WORKSPACE]: true },
      nestedGitScanRootsHydrated: false,
      activeGitRepos: {},
      activeGitReposHydrated: false,
    });
  });

  afterEach(() => {
    cleanup();
    useSidebarStore.setState(initialState);
    window.localStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Regression: the self-healing effect drops a selection the workspace no
  // longer lists, but before the first bundle arrives every workspace lists
  // nothing. Clearing then wiped the restored repo on every mount — the
  // localStorage restore path included, which is why the choice never stuck.
  it('keeps the restored selection while the workspace is still unread', async () => {
    render(sidebar());
    await act(() => vi.advanceTimersByTimeAsync(1000));

    expect(getGitBundle).toHaveBeenCalledTimes(1);
    expect(useSidebarStore.getState().activeGitRepos[CONTEXT_KEY]).toBe(NESTED);
  });

  it('loads a restored placeholder and settles without repeating the request', async () => {
    render(sidebar());
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(getGitBundle).toHaveBeenCalledTimes(1);

    await act(async () => { bundles[0](discoveryBundle); });
    await act(() => vi.advanceTimersByTimeAsync(1000));

    // The placeholder was never read, so the restored selection asks for it the
    // same way a chip click does.
    expect(getGitBundle).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getGitBundle).mock.calls[1][0]).toBe(NESTED);
    expect(useSidebarStore.getState().activeGitRepos[CONTEXT_KEY]).toBe(NESTED);

    await act(async () => { bundles[1](nestedBundle); });
    await act(() => vi.advanceTimersByTimeAsync(1000));

    expect(getGitBundle).toHaveBeenCalledTimes(2);
    expect(useSidebarStore.getState().activeGitRepos[CONTEXT_KEY]).toBe(NESTED);
    expect(useSidebarStore.getState().changedFiles.get(`${NESTED}${String.fromCharCode(0)}a.ts`)?.repoRoot).toBe(NESTED);
  });

  it('switches to another session\'s choice without refetching the workspace', async () => {
    render(sidebar());
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await act(async () => { bundles[0](discoveryBundle); });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    const requestsBeforeSwitch = vi.mocked(getGitBundle).mock.calls.length;

    // The workspace root is already loaded, so the other session's choice of it
    // needs no request of its own.
    useSidebarStore.setState({
      contextKey: OTHER_CONTEXT_KEY,
      activeGitRepos: { [CONTEXT_KEY]: NESTED, [OTHER_CONTEXT_KEY]: WORKSPACE },
    });
    await act(() => vi.advanceTimersByTimeAsync(1000));

    expect(vi.mocked(getGitBundle).mock.calls.length).toBe(requestsBeforeSwitch);
    expect(useSidebarStore.getState().activeGitRepos[CONTEXT_KEY]).toBe(NESTED);
  });
});
