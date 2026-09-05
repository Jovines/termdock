// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilePreview } from './RightSidebar';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { I18nProvider } from '../../i18n';

const { readMock } = vi.hoisted(() => ({ readMock: vi.fn() }));
vi.mock('../../terminal/api', async (original) => ({
  ...(await original<typeof import('../../terminal/api')>()), readFileContent: readMock,
}));
const noop = () => {};
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
function preview(path: string, onDirectoryLinkOpen = vi.fn()) {
  return <I18nProvider><FilePreview filePath={path} onInsertReference={noop} onInsertText={noop} onReferenceCopied={noop}
    isMobile={false} markdownOutlineOpen={false} markdownImageLightboxOpen={false}
    lineRange={null} onLineRangeChange={noop} insertedReferenceKey={null} copiedReferenceKey={null}
    onDirectoryLinkOpen={onDirectoryLinkOpen} /></I18nProvider>;
}
const response = (path: string, content: string) => ({ path, content, size: content.length, modified: '', binary: false });

beforeEach(() => {
  localStorage.clear();
  useSidebarStore.setState({ rootPath: '/project', selectedFilePath: '/project/审阅/02-guide.md' });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: noop });
  readMock.mockReset();
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
  else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
});

describe('review shortcut document navigation', () => {
  it('uses the real source for relative links, images and directory links, retaining the alias for Back', async () => {
    readMock.mockResolvedValue(response('/project/docs/guide.md', '[Notes](notes.md)\n\n![Diagram](images/example.png)\n\n[Models](../mechanical/glb/)'));
    const onDirectory = vi.fn();
    const view = render(preview('/project/审阅/02-guide.md', onDirectory));
    const notes = await screen.findByRole('link', { name: 'Notes' });
    await screen.findByRole('img', { name: 'Diagram' });
    expect(vi.mocked(fetch).mock.calls.some(([url]) => decodeURIComponent(String(url)).includes('/project/docs/images/example.png'))).toBe(true);
    fireEvent.click(screen.getByRole('link', { name: 'Models' }));
    expect(onDirectory).toHaveBeenCalledWith('/project/mechanical/glb');
    fireEvent.click(notes);
    expect(useSidebarStore.getState().selectedFilePath).toBe('/project/docs/notes.md');
    readMock.mockResolvedValue(response('/project/docs/notes.md', '# Notes page'));
    view.rerender(preview('/project/docs/notes.md', onDirectory));
    await screen.findByRole('heading', { name: 'Notes page' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to source document' }));
    expect(useSidebarStore.getState().selectedFilePath).toBe('/project/审阅/02-guide.md');
  });
  it('ignores a slow old response after selecting a newer file', async () => {
    let resolveOld!: (value: ReturnType<typeof response>) => void;
    const pending = new Promise((resolve) => { resolveOld = resolve; });
    readMock.mockReturnValue(pending);
    const view = render(preview('/project/审阅/02-guide.md'));
    await waitFor(() => expect(readMock).toHaveBeenCalled());
    readMock.mockResolvedValue(response('/project/docs/new.md', '# Current page'));
    view.rerender(preview('/project/docs/new.md'));
    await screen.findByRole('heading', { name: 'Current page' });
    resolveOld(response('/project/docs/old.md', '# Stale page'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Stale page' })).toBeNull());
    expect(screen.getByRole('heading', { name: 'Current page' })).toBeTruthy();
  });
});
