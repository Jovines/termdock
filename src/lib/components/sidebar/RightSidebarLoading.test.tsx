// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { getGitBundle } from '../../terminal/api';
import { RightSidebar } from './RightSidebar';
import type { ReactNode } from 'react';

vi.mock('./Sidebar', () => ({ Sidebar: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

vi.mock('../../terminal/api', async (original) => ({
  ...await original<typeof import('../../terminal/api')>(),
  getGitBundle: vi.fn(),
}));

const initialState = useSidebarStore.getState();
const sidebar = (isOpen: boolean) => (
  <I18nProvider><RightSidebar isOpen={isOpen} drawerWidthPx={400} onClose={() => {}} /></I18nProvider>
);

describe('sidebar loading after close and reopen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    useSidebarStore.setState({
      ...initialState, rootPath: '/workspace', rightTab: 'diff',
      hydrateNestedGitScanRoots: vi.fn(async () => {}),
      // The gate awaits both preferences; the real hydration would sit on the
      // never-resolving fetch stub below.
      hydrateActiveGitRepos: vi.fn(async () => {}),
    });
    vi.mocked(getGitBundle).mockReset();
    vi.mocked(getGitBundle).mockImplementation(() => new Promise(() => {}));
  });
  afterEach(() => {
    cleanup();
    useSidebarStore.setState(initialState);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('releases cancelled loading and requests again without waiting for the old response', async () => {
    const view = render(sidebar(true));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(getGitBundle).toHaveBeenCalledTimes(1);
    expect(useSidebarStore.getState().gitBundleLoading).toBe(true);
    const oldSignal = vi.mocked(getGitBundle).mock.calls[0][1];
    view.rerender(sidebar(false));
    expect(oldSignal?.aborted).toBe(true);
    expect(useSidebarStore.getState().gitBundleLoading).toBe(false);
    view.rerender(sidebar(true));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(getGitBundle).toHaveBeenCalledTimes(2);
  });

  it('does not start an obsolete request when preferences resolve after closing', async () => {
    let resolve!: () => void;
    const preferences = new Promise<void>((done) => { resolve = done; });
    useSidebarStore.setState({ hydrateNestedGitScanRoots: () => preferences });
    const view = render(sidebar(true));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(getGitBundle).not.toHaveBeenCalled();
    view.rerender(sidebar(false));
    await act(async () => { resolve(); await preferences; });
    expect(getGitBundle).not.toHaveBeenCalled();
    view.rerender(sidebar(true));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(getGitBundle).toHaveBeenCalledTimes(1);
  });
});
