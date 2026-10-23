// @vitest-environment jsdom
import { useRef, useState, type KeyboardEvent } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { useSidebarStore, type FileTreeNode } from '../../stores/useSidebarStore';
import { FileTree } from './FileTree';
import { navigateFileWithArrowKey } from './fileKeyboardNavigation';

const { listDirectory, searchFilesStream } = vi.hoisted(() => ({ listDirectory: vi.fn(), searchFilesStream: vi.fn() }));
vi.mock('../../terminal/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../terminal/api')>()),
  listDirectory,
  searchFilesStream,
}));
const file = (name: string, parent = '/workspace'): FileTreeNode => ({ name, path: `${parent}/${name}`, type: 'file', expanded: false, loaded: false });
const scrollIntoView = vi.fn();
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

function Fixture({ query = '', mode = 'name' }: { query?: string; mode?: 'name' | 'content' }) {
  const tree = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>('/workspace/a.md');
  return <I18nProvider>
    <input aria-label="Outside" />
    <div tabIndex={-1} data-testid="pane" onKeyDown={(event: KeyboardEvent<HTMLElement>) => navigateFileWithArrowKey(event, tree.current, selected, setSelected)}>
      <div ref={tree}><FileTree rootPath="/workspace" selectedFilePath={selected} onFileSelect={setSelected} query={query} searchMode={mode} /></div>
      <div tabIndex={-1} data-testid="preview">{selected}</div>
      <input aria-label="Search" />
      <div contentEditable suppressContentEditableWarning data-testid="editor">Draft</div>
      <div role="menu" tabIndex={0}>Menu</div>
    </div>
  </I18nProvider>;
}

async function fixture(props: Parameters<typeof Fixture>[0] = {}) {
  const view = render(<Fixture {...props} />);
  await waitFor(() => expect(view.container.querySelector('[data-file-tree-path="/workspace/a.md"]')).toBeTruthy());
  return { ...view, row: (path: string) => view.container.querySelector<HTMLElement>(`[data-file-tree-path="${path}"]`)! };
}

describe('file browser arrow navigation', () => {
  beforeEach(() => {
    const entries: FileTreeNode[] = [file('a.md'), { name: 'folder', path: '/workspace/folder', type: 'directory', expanded: false, loaded: true }, file('b.md'), file('c.md')];
    useSidebarStore.setState({ rootPath: '/workspace', expandedPaths: new Set(), directoryCache: new Map(), fileSortModes: {}, fileSortModesHydrated: true, hideGitIgnoredRootsHydrated: true, hideGitIgnoredRoots: {}, gitIgnoreExceptions: {} });
    listDirectory.mockImplementation(async (path: string) => ({ path, entries: path === '/workspace' ? entries : [file('nested.md', path)] }));
    searchFilesStream.mockImplementation((_root, _query, progress, _signal, _hidden, mode) => {
      if (mode === 'content') progress({ contentEntries: [file('a.md'), file('b.md')].map(entry => ({ ...entry, matches: [{ line: 1, text: 'needle' }] })), done: true });
      else progress({ entries: [file('a.md'), file('b.md')], done: true });
      return Promise.resolve();
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"locale":"en"}')));
  });
  afterEach(() => {
    cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); scrollIntoView.mockClear();
    if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll);
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('switches previews continuously, skips collapsed folders, keeps row focus and stops at the ends', async () => {
    const user = userEvent.setup();
    const { row } = await fixture();
    await user.click(row('/workspace/a.md'));
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(screen.getByTestId('preview').textContent).toBe('/workspace/c.md');
    expect(document.activeElement).toBe(row('/workspace/c.md'));
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(screen.getByTestId('preview').textContent).toBe('/workspace/a.md');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    expect(listDirectory).not.toHaveBeenCalledWith('/workspace/folder', expect.anything());
  });

  it('follows the rendered order through expanded directories', async () => {
    const user = userEvent.setup();
    const { row } = await fixture();
    await user.click(row('/workspace/folder'));
    await waitFor(() => expect(row('/workspace/folder/nested.md')).toBeTruthy());
    await user.click(row('/workspace/a.md'));
    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('preview').textContent).toBe('/workspace/folder/nested.md');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('preview').textContent).toBe('/workspace/b.md');
  });

  it('switches from the preview while keeping preview focus', async () => {
    const user = userEvent.setup();
    await fixture();
    const preview = screen.getByTestId('preview');
    preview.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}');
    expect(preview.textContent).toBe('/workspace/b.md');
    expect(document.activeElement).toBe(preview);
  });

  it.each(['name', 'content'] as const)('switches files in %s search results', async mode => {
    const user = userEvent.setup();
    await fixture({ query: 'needle', mode });
    screen.getByTestId('preview').focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('preview').textContent).toBe('/workspace/b.md');
  });

  it('leaves text fields, editable content, menus, nested actions and outside focus alone', async () => {
    const user = userEvent.setup();
    const { row } = await fixture();
    for (const target of [screen.getByRole('textbox', { name: 'Search' }), screen.getByTestId('editor'), screen.getByRole('menu'), screen.getByRole('textbox', { name: 'Outside' }), row('/workspace/a.md').querySelector('button')!]) {
      target.focus();
      await user.keyboard('{ArrowDown}');
      expect(screen.getByTestId('preview').textContent).toBe('/workspace/a.md');
      expect(document.activeElement).toBe(target);
    }
  });

  it('preserves modified, composing, consumed keys and native text selection', async () => {
    await fixture();
    const preview = screen.getByTestId('preview');
    for (const modifiers of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
      fireEvent.keyDown(preview, { key: 'ArrowDown', ...modifiers });
    }
    const consumed = new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    consumed.preventDefault(); preview.dispatchEvent(consumed);
    const selection = window.getSelection()!;
    selection.selectAllChildren(preview);
    fireEvent.keyDown(preview, { key: 'ArrowDown' });
    selection.removeAllRanges();
    expect(preview.textContent).toBe('/workspace/a.md');
  });
});
