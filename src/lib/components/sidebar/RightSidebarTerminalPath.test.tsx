// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { I18nProvider } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { DeferredRightSidebar } from './DeferredRightSidebar';

vi.mock('./Sidebar', () => ({ Sidebar: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('./FileTree', () => ({
  FileTree: ({ rootPath, revealDirectory }: { rootPath: string; revealDirectory?: { path: string; nonce: number } }) => (
    <div data-testid="tree" data-root={rootPath} data-target={revealDirectory?.path} data-nonce={revealDirectory?.nonce} />
  ),
}));

const initialState = useSidebarStore.getState();
function SidebarFixture() {
  const isOpen = useSidebarStore(s => s.rightOpen);
  return <I18nProvider><DeferredRightSidebar isOpen={isOpen} drawerWidthPx={900} onClose={() => {}} /></I18nProvider>;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  useSidebarStore.setState({ ...initialState, rootPath: '/workspace', explorerRoot: '/workspace', rightOpen: false });
});
afterEach(() => {
  cleanup();
  useSidebarStore.setState(initialState);
  vi.unstubAllGlobals();
});

describe('terminal links opening the deferred sidebar', () => {
  it('retains the first file click until the sidebar mounts, including an external parent root', async () => {
    render(<SidebarFixture />);
    expect(screen.queryByTestId('tree')).toBeNull();
    act(() => useSidebarStore.getState().openTerminalPath({ path: '/tmp/logs/output.txt', kind: 'file', line: 12 }));
    await waitFor(() => expect(screen.getByTestId('tree').dataset.target).toBe('/tmp/logs/output.txt'));
    expect(screen.getByTestId('tree').dataset.root).toBe('/tmp/logs');
    expect(useSidebarStore.getState().selectedFilePath).toBe('/tmp/logs/output.txt');
    expect(useSidebarStore.getState().pendingTerminalPath).toBeNull();

    // Subsequent and repeated clicks still issue a new reveal.
    act(() => useSidebarStore.getState().openTerminalPath({ path: '/workspace/src/main.ts', kind: 'file' }));
    await waitFor(() => expect(screen.getByTestId('tree').dataset.target).toBe('/workspace/src/main.ts'));
    expect(screen.getByTestId('tree').dataset.root).toBe('/workspace');
    const nonce = screen.getByTestId('tree').dataset.nonce;
    act(() => useSidebarStore.getState().openTerminalPath({ path: '/workspace/src/main.ts', kind: 'file' }));
    await waitFor(() => expect(screen.getByTestId('tree').dataset.nonce).not.toBe(nonce));
  });

  it('uses the latest directory request made before any sidebar mount', async () => {
    useSidebarStore.getState().openTerminalPath({ path: '/workspace/old.txt', kind: 'file' });
    useSidebarStore.getState().openTerminalPath({ path: '/workspace/src/lib', kind: 'directory' });
    render(<SidebarFixture />);
    await waitFor(() => expect(screen.getByTestId('tree').dataset.target).toBe('/workspace/src/lib'));
    expect(screen.getByTestId('tree').dataset.root).toBe('/workspace');
    expect(useSidebarStore.getState().selectedFilePath).toBeNull();
    expect(useSidebarStore.getState().pendingTerminalPath).toBeNull();
  });

  it('drops an unhandled request when changing session context', () => {
    useSidebarStore.getState().openTerminalPath({ path: '/workspace/old.txt', kind: 'file' });
    useSidebarStore.getState().setRootPath('/other', 'other-session');
    expect(useSidebarStore.getState().pendingTerminalPath).toBeNull();
  });
});
