// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { MarkdownParseBudget, MarkdownParseError } from './markdownParseBudget';
import { FilePreview, MarkdownPreview, buildMarkdownPreviewRenderResult } from './RightSidebar';
import { readFileContent } from '../../terminal/api';
import { useSidebarStore } from '../../stores/useSidebarStore';

vi.mock('../../terminal/api', async (original) => ({
  ...await original<typeof import('../../terminal/api')>(),
  readFileContent: vi.fn(),
}));

const noop = () => {};
const props = {
  filePath: '/repo/report.lark.md', onReferenceCopied: noop, onInsertReference: noop, onInsertText: noop, onInsertFeature: noop,
  isMobile: false, markdownOutlineOpen: false, markdownImageLightboxOpen: false,
  lineRange: null, onLineRangeChange: noop, insertedReferenceKey: null, copiedReferenceKey: null,
};
const originalState = useSidebarStore.getState();
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');

function clientLogs() {
  return vi.mocked(fetch).mock.calls.flatMap(([url, init]) => url === '/api/client-log' && typeof init?.body === 'string' ? [JSON.parse(init.body)] : []);
}

beforeEach(() => {
  localStorage.clear();
  useSidebarStore.setState({ rootPath: '/repo' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  useSidebarStore.setState(originalState);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
  else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
});

describe('Markdown preview failure recovery', () => {
  it('renders the reported identifier/link combination without emphasis', async () => {
    const url = `https://example.com/${'a'.repeat(1_000)}/table_value`;
    const content = `search_id [x](${url})`;
    vi.mocked(readFileContent).mockResolvedValue({ path: props.filePath, content, size: content.length, modified: '', binary: false });
    const view = render(<I18nProvider><FilePreview {...props} /></I18nProvider>);
    const link = await screen.findByRole('link', { name: 'x' });
    expect(link.getAttribute('href')).toBe(url);
    expect(view.container.querySelector('em')).toBeNull();
    expect(clientLogs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'FILE_PREVIEW_LOADING start' }),
      expect.objectContaining({ message: 'FILE_PREVIEW_LOADING end', data: expect.objectContaining({ reason: 'text_loaded' }) }),
    ]));
  });

  it('shows a parse error and literal source, ends loading, and keeps source controls usable', async () => {
    const content = `search_id [x](https://example.com/${'a'.repeat(20_000)}`;
    vi.mocked(readFileContent).mockResolvedValue({ path: props.filePath, content, size: content.length, modified: '', binary: false });
    const view = render(<I18nProvider><FilePreview {...props} /></I18nProvider>);
    await screen.findByRole('alert');
    expect(view.container.querySelector('[data-markdown-preview-fallback] pre')?.textContent).toBe(content);
    expect(clientLogs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'FILE_PREVIEW_LOADING end', data: expect.objectContaining({ reason: 'text_loaded' }) }),
      expect.objectContaining({ message: 'FILE_PREVIEW_LOADING markdown_error', data: expect.objectContaining({ fallback: 'plain_text' }) }),
    ]));
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    await waitFor(() => expect(view.container.querySelector('[data-file-preview-line]')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('falls back on deadline expiry and recovers when the file content changes', () => {
    const check = vi.spyOn(MarkdownParseBudget.prototype, 'check').mockImplementation(() => { throw new MarkdownParseError('timeout'); });
    const view = render(<MarkdownPreview content="original source" filePath={props.filePath} rootPath="/repo" lineRange={null} onLineRangeClick={noop} scrollTop={0} outlineOpen={false} lightboxOpen={false} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(view.container.querySelector('pre')?.textContent).toBe('original source');
    check.mockRestore();
    view.rerender(<MarkdownPreview content="# Recovered" filePath={props.filePath} rootPath="/repo" lineRange={null} onLineRangeClick={noop} scrollTop={0} outlineOpen={false} lightboxOpen={false} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Recovered' })).toBeTruthy();
  });

  it('rejects deeply nested lists before overflowing the renderer stack', () => {
    const lines = Array.from({ length: 50 }, (_, index) => `${'  '.repeat(index)}- item`);
    expect(() => buildMarkdownPreviewRenderResult(lines, null, null)).toThrow('depth');
  });
});
