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
vi.mock('../computer/ComputerControlView', () => ({ default: () => <div>Computer content</div> }));
vi.mock('../../terminal/api', async original => ({
  ...await original<typeof import('../../terminal/api')>(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(async () => ({})),
}));

const initialState = useSidebarStore.getState();
const sidebar = (width = 800) => <I18nProvider><RightSidebar isOpen drawerWidthPx={width} onClose={() => {}} /></I18nProvider>;

beforeEach(() => {
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
  it.each([800, 360])('can hide and restore both tabs at width %s', async width => {
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
