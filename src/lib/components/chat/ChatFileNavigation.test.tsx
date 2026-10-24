// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { useSessionDirectoryStore } from '../../stores/useSessionDirectory';
import { SessionCapabilitiesContext, ShareAccessContext } from '../../federation/ShareAccessContext';
import { sharedSessionCapabilities } from '../../federation/sessionCapabilities';
import { readFileContent } from '../../terminal/api';
import { ChatFileNavigation } from './ChatFileNavigation';
import { ChatMarkdown } from './ChatMarkdown';

vi.mock('../../terminal/api', async importOriginal => ({ ...await importOriginal<typeof import('../../terminal/api')>(), readFileContent: vi.fn() }));
const sidebar = useSidebarStore.getState();
const directory = useSessionDirectoryStore.getState();
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
beforeEach(() => {
  localStorage.clear();
  useSidebarStore.setState({ rootPath: '/different-workspace', selectedFilePath: 'keep.md', rightOpen: false });
  useSessionDirectoryStore.setState({ records: [{ sessionId: 'chat', name: 'chat', cwd: '/repo', lastActivity: 1 }] });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.mocked(readFileContent).mockImplementation(async path => ({ path, content: path.endsWith('guide.md') ? '# 指南\n\n[下一份](./next.md)' : '# 下一份文档', size: 50, modified: '', binary: false }));
});
afterEach(() => {
  cleanup();
  useSidebarStore.setState(sidebar);
  useSessionDirectoryStore.setState(directory);
  vi.mocked(readFileContent).mockReset();
  vi.unstubAllGlobals();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
  else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
});
const chat = (content: string, active = true) => <I18nProvider><ChatFileNavigation sessionId="chat" active={active}><ChatMarkdown content={content} /></ChatFileNavigation></I18nProvider>;

it('opens relative Markdown links in a modal, keeps further navigation there, and leaves the sidebar intact', async () => {
  render(chat('[下发配置](docs/guide.md)'));
  expect(fireEvent.click(screen.getByRole('link', { name: '下发配置' }))).toBe(false);
  const dialog = await screen.findByRole('dialog', { name: '文件预览' });
  expect(await within(dialog).findByRole('heading', { name: '指南' })).toBeTruthy();
  expect(readFileContent).toHaveBeenCalledWith('/repo/docs/guide.md', expect.any(AbortSignal), 'view_file', expect.any(String));
  fireEvent.click(within(dialog).getByRole('link', { name: '下一份' }));
  expect(await within(dialog).findByRole('heading', { name: '下一份文档' })).toBeTruthy();
  expect(within(dialog).getAllByTitle('/repo/docs/next.md')).toHaveLength(2);
  expect(useSidebarStore.getState()).toMatchObject({ rightOpen: false, selectedFilePath: 'keep.md', rootPath: '/different-workspace' });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('link', { name: '下发配置' }));
  expect(await screen.findByRole('dialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '关闭文件预览' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('preserves absolute filesystem paths outside cwd and does not intercept external links', async () => {
  render(chat('[布局测量](/tmp/measurements.md) [官方网站](https://example.com/docs)'));
  fireEvent.click(screen.getByRole('link', { name: '布局测量' }));
  await screen.findByRole('heading', { name: '下一份文档' });
  expect(readFileContent).toHaveBeenCalledWith('/tmp/measurements.md', expect.any(AbortSignal), 'view_file', expect.any(String));
  const external = screen.getByRole('link', { name: '官方网站' });
  expect(external.getAttribute('href')).toBe('https://example.com/docs');
  expect(external.getAttribute('target')).toBe('_blank');
});

it('keeps failed reads in the preview and allows dismissing the error', async () => {
  vi.mocked(readFileContent).mockRejectedValue(new Error('文件读取失败'));
  render(chat('[不存在](/tmp/missing.md)'));
  fireEvent.click(screen.getByRole('link', { name: '不存在' }));
  expect(await screen.findByText('文件读取失败')).toBeTruthy();
  fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('does not open local links for inactive conversations or shared sessions without file grants', () => {
  const view = render(chat('[配置](docs/guide.md)', false));
  expect(fireEvent.click(screen.getByRole('link', { name: '配置' }))).toBe(false);
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(<ShareAccessContext.Provider value={{}}><SessionCapabilitiesContext.Provider value={sharedSessionCapabilities({ canWrite: true })}>{chat('[配置](/repo/docs/guide.md)')}</SessionCapabilitiesContext.Provider></ShareAccessContext.Provider>);
  expect(fireEvent.click(screen.getByRole('link', { name: '配置' }))).toBe(false);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(readFileContent).not.toHaveBeenCalled();
});

it('restricts shared file previews to explicit directory grants', async () => {
  const grants = { directories: [{ path: '/shared', access: 'read' as const }] };
  render(<ShareAccessContext.Provider value={grants}><SessionCapabilitiesContext.Provider value={sharedSessionCapabilities({}, grants)}>{chat('[越界](/private/secret.md) [文档](guide.md)')}</SessionCapabilitiesContext.Provider></ShareAccessContext.Provider>);
  fireEvent.click(screen.getByRole('link', { name: '越界' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(readFileContent).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('link', { name: '文档' }));
  await waitFor(() => expect(readFileContent).toHaveBeenCalledWith('/shared/guide.md', expect.any(AbortSignal), 'view_file', expect.any(String)));
});
