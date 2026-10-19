// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { I18nProvider } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { getSettings, updateSettings } from '../../terminal/api';
import { RightSidebar } from './RightSidebar';

vi.mock('./Sidebar', () => ({ Sidebar: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('./ArchitecturePanel', () => ({ ArchitecturePanel: () => <div>Architecture content</div> }));
const computerLife = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));
vi.mock('../computer/ComputerControlView', async () => {
  const { useEffect } = await import('react');
  return { default: ({ active }: { active: boolean }) => {
    useEffect(() => { computerLife.mounts++; return () => { computerLife.unmounts++; }; }, []);
    return <div data-computer-active={String(active)}>Computer content</div>;
  } };
});
vi.mock('../android/AndroidMirrorView', () => ({
  AndroidMirrorView: () => <div>Device content</div>,
  ANDROID_DOCK_GROUP: 'android-mirror',
}));
vi.mock('../../terminal/api', async original => ({
  ...await original<typeof import('../../terminal/api')>(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(async () => ({})),
}));

const initialState = useSidebarStore.getState();
const sidebar = (width = 800, open = true) => <I18nProvider><RightSidebar isOpen={open} drawerWidthPx={width} onClose={() => {}} /></I18nProvider>;

beforeEach(() => {
  computerLife.mounts = 0; computerLife.unmounts = 0;
  localStorage.setItem('termdock:locale', 'zh');
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  useSidebarStore.setState({ ...initialState, rootPath: null, rightTab: 'files' });
  vi.mocked(getSettings).mockResolvedValue({ locale: 'zh' } as Awaited<ReturnType<typeof getSettings>>);
  vi.mocked(updateSettings).mockClear();
});

afterEach(() => {
  cleanup();
  useSidebarStore.setState(initialState);
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('optional right sidebar tabs', () => {
  const tabs = [
    { label: '架构', menu: '显示架构 Tab', key: 'architecture', patch: { rightSidebarTabs: { architecture: true } } },
    { label: '电脑', menu: '显示电脑 Tab', key: 'computer', patch: { rightSidebarTabs: { computer: true } } },
    { label: '设备', menu: '显示设备 Tab', key: 'android', patch: { androidPanel: { enabled: true } } },
  ] as const;

  it.each([800, 360])('defaults all three tabs to hidden and saves opt-in choices at width %s', async width => {
    render(sidebar(width));
    await act(async () => {});
    fireEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0]);
    for (const tab of tabs) {
      expect(screen.queryByRole('button', { name: tab.label })).toBeNull();
      expect(screen.getByRole('menuitemcheckbox', { name: tab.menu }).getAttribute('aria-checked')).toBe('false');
    }
    expect(updateSettings).not.toHaveBeenCalled();
    for (const tab of tabs) {
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: tab.menu }));
      expect(screen.getByRole('button', { name: tab.label })).toBeTruthy();
      expect(useSidebarStore.getState().rightTab).toBe(tab.key);
      expect(updateSettings).toHaveBeenCalledWith(tab.patch);
    }
  });

  it('restores saved choices for all three tabs on each mount', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      locale: 'zh', rightSidebarTabs: { architecture: true, computer: false }, androidPanel: { enabled: true },
    } as Awaited<ReturnType<typeof getSettings>>);
    for (let mount = 0; mount < 2; mount++) {
      const view = render(sidebar());
      await waitFor(() => expect(screen.getByRole('button', { name: '设备' })).toBeTruthy());
      expect(screen.getByRole('button', { name: '架构' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: '电脑' })).toBeNull();
      view.unmount();
    }
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it.each(tabs)('preserves a new $label choice while initial settings are still loading', async tab => {
    let resolveSettings!: (settings: Awaited<ReturnType<typeof getSettings>>) => void;
    vi.mocked(getSettings).mockReturnValue(new Promise(resolve => { resolveSettings = resolve; }));
    render(sidebar());
    fireEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0]);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: tab.menu }));
    await act(async () => resolveSettings({
      rightSidebarTabs: { architecture: false, computer: false }, androidPanel: { enabled: false },
    } as Awaited<ReturnType<typeof getSettings>>));
    expect(screen.getByRole('button', { name: tab.label })).toBeTruthy();
    expect(screen.getByRole('menuitemcheckbox', { name: tab.menu }).getAttribute('aria-checked')).toBe('true');
    expect(updateSettings).toHaveBeenCalledWith(tab.patch);
  });

  it('keeps all three tabs hidden when loading settings fails', async () => {
    vi.mocked(getSettings).mockRejectedValue(new Error('offline'));
    render(sidebar());
    await act(async () => {});
    for (const tab of tabs) expect(screen.queryByRole('button', { name: tab.label })).toBeNull();
  });

  it.each([800, 360])('can hide and restore both tabs at width %s', async width => {
    vi.mocked(getSettings).mockResolvedValue({
      locale: 'zh', rightSidebarTabs: { architecture: true, computer: true },
    } as Awaited<ReturnType<typeof getSettings>>);
    render(sidebar(width));
    await act(async () => {});
    fireEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0]);
    const architecture = screen.getByRole('menuitemcheckbox', { name: '显示架构 Tab' });
    const computer = screen.getByRole('menuitemcheckbox', { name: '显示电脑 Tab' });
    expect(architecture.getAttribute('aria-checked')).toBe('true');
    expect(computer.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '架构' }));
    expect(useSidebarStore.getState().rightTab).toBe('architecture');
    fireEvent.click(architecture);
    expect(screen.queryByRole('button', { name: '架构' })).toBeNull();
    expect(useSidebarStore.getState().rightTab).toBe('files');
    expect(updateSettings).toHaveBeenCalledWith({ rightSidebarTabs: { architecture: false } });

    fireEvent.click(screen.getByRole('button', { name: '电脑' }));
    fireEvent.click(computer);
    expect(screen.queryByRole('button', { name: '电脑' })).toBeNull();
    expect(useSidebarStore.getState().rightTab).toBe('files');
    expect(screen.getByRole('button', { name: '文件' }).parentElement?.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
    expect(updateSettings).toHaveBeenCalledWith({ rightSidebarTabs: { computer: false } });

    fireEvent.click(architecture);
    expect(screen.getByRole('button', { name: '架构' })).toBeTruthy();
    expect(useSidebarStore.getState().rightTab).toBe('architecture');
    fireEvent.click(computer);
    expect(screen.getByRole('button', { name: '电脑' })).toBeTruthy();
    expect(useSidebarStore.getState().rightTab).toBe('computer');
    expect(updateSettings).toHaveBeenCalledWith({ rightSidebarTabs: { architecture: true } });
    expect(updateSettings).toHaveBeenCalledWith({ rightSidebarTabs: { computer: true } });
  });

  it('restores hidden tabs and renders files when a saved tab is hidden', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      locale: 'zh', rightSidebarTabs: { architecture: false, computer: false },
    } as Awaited<ReturnType<typeof getSettings>>);
    useSidebarStore.setState({ rightTab: 'architecture' });
    const view = render(sidebar());
    await waitFor(() => expect(screen.queryByRole('button', { name: '架构' })).toBeNull());
    expect(screen.queryByRole('button', { name: '电脑' })).toBeNull();
    expect(screen.getByRole('button', { name: '文件' }).className).toContain('bg-surface-elevated');
    view.unmount();
    render(sidebar());
    await waitFor(() => expect(screen.queryByRole('button', { name: '电脑' })).toBeNull());
  });
});

it('retains the computer pane across closing and tab switches, and tells it when interaction is hidden', async () => {
  vi.mocked(getSettings).mockResolvedValue({ locale: 'zh', rightSidebarTabs: { computer: true } } as Awaited<ReturnType<typeof getSettings>>);
  const view = render(sidebar(360));
  await waitFor(() => expect(screen.getByRole('button', { name: '电脑' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: '电脑' }));
  const pane = await screen.findByText('Computer content');
  expect(pane.getAttribute('data-computer-active')).toBe('true');
  view.rerender(sidebar(360, false));
  expect(pane.isConnected).toBe(true); expect(pane.getAttribute('data-computer-active')).toBe('false');
  act(() => useSidebarStore.setState({ rightTab: 'files' }));
  view.rerender(sidebar(360));
  expect(pane.isConnected).toBe(true); expect(pane.getAttribute('data-computer-active')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: '电脑' }));
  expect(screen.getByText('Computer content')).toBe(pane);
  expect(pane.getAttribute('data-computer-active')).toBe('true');
  expect(computerLife).toEqual({ mounts: 1, unmounts: 0 });
  view.unmount(); expect(computerLife.unmounts).toBe(1);
});
