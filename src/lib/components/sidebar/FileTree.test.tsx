// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { useSidebarStore, type FileTreeNode } from '../../stores/useSidebarStore';
import { FileTree } from './FileTree';

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

const { deleteFileMock, downloadFileMock, searchFilesStreamMock, getSettingsMock, listDirectoryMock, updateSettingsMock } = vi.hoisted(() => ({
  deleteFileMock: vi.fn(async () => undefined),
  downloadFileMock: vi.fn(async () => undefined),
  searchFilesStreamMock: vi.fn(),
  getSettingsMock: vi.fn(async () => ({ fileSortModes: {} })),
  listDirectoryMock: vi.fn(async (path: string): Promise<{ path: string; entries: FileTreeNode[] }> => ({ path, entries: [] })),
  updateSettingsMock: vi.fn(async (settings: { fileSortMode?: { path: string; mode: 'name' | 'modified' } }) => ({
    fileSortModes: settings.fileSortMode?.mode === 'modified' ? { [settings.fileSortMode.path]: 'modified' } : {},
  })),
}));

vi.mock('../../terminal/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../terminal/api')>()),
  deleteFile: deleteFileMock,
  downloadFile: downloadFileMock,
  searchFilesStream: searchFilesStreamMock,
  getSettings: getSettingsMock,
  listDirectory: listDirectoryMock,
  updateSettings: updateSettingsMock,
}));

async function renderFixture(ui: Parameters<typeof render>[0]) {
  const entries = new Map(useSidebarStore.getState().directoryCache);
  listDirectoryMock.mockImplementation(async (path: string) => ({ path, entries: entries.get(path) ?? [] }));
  useSidebarStore.setState({ hideGitIgnoredRootsHydrated: true });
  const view = render(ui);
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  return view;
}

describe('FileTree file deletion', () => {
  beforeEach(() => {
    useSidebarStore.setState({
      rootPath: '/workspace',
      selectedFilePath: '/workspace/notes.txt',
      expandedPaths: new Set(),
      fileSortModes: {},
      fileSortModesHydrated: true,
      directoryCache: new Map([['/workspace', [{
        name: 'notes.txt',
        path: '/workspace/notes.txt',
        type: 'file',
        expanded: false,
        loaded: false,
      }]]]),
    });
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ locale: 'en' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
  });

  afterEach(() => {
    cleanup();
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    deleteFileMock.mockClear();
    downloadFileMock.mockReset();
    searchFilesStreamMock.mockReset();
    listDirectoryMock.mockClear();
    getSettingsMock.mockClear();
    updateSettingsMock.mockClear();
    vi.unstubAllGlobals();
  });

  it('tabs to file actions and activates them without opening the row', async () => {
    const user = userEvent.setup(); const onFileSelect = vi.fn(); const onPathReference = vi.fn();
    await renderFixture(<I18nProvider><FileTree rootPath="/workspace" selectedFilePath={null} onFileSelect={onFileSelect} onPathReference={onPathReference} /></I18nProvider>);
    screen.getByTitle('/workspace/notes.txt').focus();
    await user.tab();
    let more = screen.getByRole('button', { name: 'More file actions' });
    expect(document.activeElement).toBe(more);
    expect(more.tagName).toBe('BUTTON');
    await user.keyboard('{Enter}');
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Download file' })).toBeTruthy();
    await user.keyboard('{Escape}');
    more = screen.getByRole('button', { name: 'More file actions' }); more.focus(); await user.keyboard(' ');
    expect(more.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{Escape}');
    more = screen.getByRole('button', { name: 'More file actions' }); more.focus(); await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Insert file reference into active terminal' }));
    await user.keyboard(' ');
    expect(onPathReference).toHaveBeenCalledExactlyOnceWith('/workspace/notes.txt', 'path:/workspace/notes.txt');
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it('opens folder actions with the keyboard without expanding the folder', async () => {
    const user = userEvent.setup(); const onPathReference = vi.fn();
    useSidebarStore.setState({ directoryCache: new Map([['/workspace', [{ name: 'src', path: '/workspace/src', type: 'directory', expanded: false, loaded: true, children: [] }]]]) });
    await renderFixture(<I18nProvider><FileTree rootPath="/workspace" selectedFilePath={null} onFileSelect={vi.fn()} onSearchFromDirectory={vi.fn()} onPathReference={onPathReference} /></I18nProvider>);
    screen.getByTitle('/workspace/src').focus(); await user.tab();
    let more = screen.getByRole('button', { name: 'More folder actions' });
    expect(document.activeElement).toBe(more);
    await user.keyboard(' ');
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(useSidebarStore.getState().expandedPaths.has('/workspace/src')).toBe(false);
    await user.keyboard('{Escape}'); more.focus(); await user.tab(); await user.keyboard('{Enter}');
    expect(onPathReference).toHaveBeenCalledWith('/workspace/src', 'path:/workspace/src');
    expect(useSidebarStore.getState().expandedPaths.has('/workspace/src')).toBe(false);
  });

  it.each(['name', 'content'] as const)('keeps %s search result actions keyboard accessible without opening or collapsing results', async (mode) => {
    const user = userEvent.setup(); const onFileSelect = vi.fn(); const onPathReference = vi.fn();
    searchFilesStreamMock.mockImplementation(async (_root, _query, onProgress) => {
      onProgress(mode === 'content' ? { contentEntries: [{ name: 'notes.txt', path: '/workspace/notes.txt', matches: [{ line: 1, text: 'needle content' }] }], done: true } : { entries: [{ name: 'notes.txt', path: '/workspace/notes.txt', type: 'file' }], done: true });
    });
    await renderFixture(<I18nProvider><FileTree rootPath="/workspace" selectedFilePath={null} onFileSelect={onFileSelect} onPathReference={onPathReference} query="needle" searchMode={mode} /></I18nProvider>);
    await screen.findByTitle('/workspace/notes.txt');
    screen.getByTitle('/workspace/notes.txt').focus(); await user.tab();
    if (mode === 'name') {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More file actions' }));
      await user.keyboard('{Enter}'); await user.keyboard('{Escape}');
      screen.getByRole('button', { name: 'More file actions' }).focus(); await user.tab();
    } else {
      const download = screen.getByRole('button', { name: 'Download file' });
      expect(document.activeElement).toBe(download);
      await user.keyboard('{Enter}');
      await waitFor(() => expect(downloadFileMock).toHaveBeenCalledWith('/workspace/notes.txt'));
      expect(screen.getByTitle('notes.txt:1')).toBeTruthy();
      download.focus(); await user.keyboard(' ');
      await waitFor(() => expect(downloadFileMock).toHaveBeenCalledTimes(2));
      download.focus(); await user.tab();
    }
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Insert file reference into active terminal' }));
    await user.keyboard('{Enter}');
    expect(onPathReference).toHaveBeenCalledExactlyOnceWith('/workspace/notes.txt', 'path:/workspace/notes.txt');
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it('only deletes after the user confirms the irreversible action', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);

    await renderFixture(
      <I18nProvider>
        <FileTree
          rootPath="/workspace"
          selectedFilePath="/workspace/notes.txt"
          onFileSelect={vi.fn()}
        />
      </I18nProvider>,
    );

    await user.click(screen.getByTitle('More file actions'));
    await user.click(screen.getByRole('button', { name: 'Delete file' }));
    expect(confirm).toHaveBeenLastCalledWith('Delete “notes.txt”? This action cannot be undone.');
    expect(deleteFileMock).not.toHaveBeenCalled();

    await user.click(screen.getByTitle('More file actions'));
    await user.click(screen.getByRole('button', { name: 'Delete file' }));

    await waitFor(() => expect(deleteFileMock).toHaveBeenCalledWith('/workspace/notes.txt'));
    await waitFor(() => expect(screen.queryByText('notes.txt')).toBeNull());
    expect(useSidebarStore.getState().selectedFilePath).toBeNull();
  });

  it('expands and scrolls to a directory requested by a Markdown link', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    useSidebarStore.setState({
      selectedFilePath: null,
      expandedPaths: new Set(),
      directoryCache: new Map([
        ['/workspace', [{ name: 'mechanical', path: '/workspace/mechanical', type: 'directory', expanded: false, loaded: true, children: [] }]],
        ['/workspace/mechanical', [{ name: 'preview', path: '/workspace/mechanical/preview', type: 'directory', expanded: false, loaded: true, children: [] }]],
        ['/workspace/mechanical/preview', []],
      ]),
    });

    await renderFixture(
      <I18nProvider>
        <FileTree
          rootPath="/workspace"
          selectedFilePath={null}
          onFileSelect={vi.fn()}
          revealDirectory={{ path: '/workspace/mechanical/preview', nonce: 1 }}
        />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByText('preview')).toBeTruthy());
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' }));
    expect(useSidebarStore.getState().expandedPaths).toEqual(new Set([
      '/workspace/mechanical',
      '/workspace/mechanical/preview',
    ]));
  });

  it('expands ancestors and scrolls to a file requested by a terminal link', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    useSidebarStore.setState({
      selectedFilePath: '/workspace/src/lib/pathLinks.ts',
      expandedPaths: new Set(),
      directoryCache: new Map([
        ['/workspace', [{ name: 'src', path: '/workspace/src', type: 'directory', expanded: false, loaded: true, children: [] }]],
        ['/workspace/src', [{ name: 'lib', path: '/workspace/src/lib', type: 'directory', expanded: false, loaded: true, children: [] }]],
        ['/workspace/src/lib', [{ name: 'pathLinks.ts', path: '/workspace/src/lib/pathLinks.ts', type: 'file', expanded: false, loaded: true }]],
      ]),
    });

    await renderFixture(
      <I18nProvider>
        <FileTree
          rootPath="/workspace"
          selectedFilePath="/workspace/src/lib/pathLinks.ts"
          onFileSelect={vi.fn()}
          revealDirectory={{ path: '/workspace/src/lib/pathLinks.ts', nonce: 1 }}
        />
      </I18nProvider>,
    );

    await waitFor(() => expect(screen.getByText('pathLinks.ts')).toBeTruthy());
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' }));
    expect(useSidebarStore.getState().expandedPaths).toEqual(new Set([
      '/workspace/src',
      '/workspace/src/lib',
      '/workspace/src/lib/pathLinks.ts',
    ]));
  });

  it('reuses the explorer as a safe directory-only browser', async () => {
    const user = userEvent.setup();
    const onDirectoryRoot = vi.fn();
    useSidebarStore.setState({
      selectedFilePath: null,
      expandedPaths: new Set(),
      directoryCache: new Map([['/workspace', [
        { name: 'project', path: '/workspace/project', type: 'directory', expanded: false, loaded: true, children: [] },
        { name: 'notes.txt', path: '/workspace/notes.txt', type: 'file', expanded: false, loaded: true },
      ]]]),
    });

    await renderFixture(
      <I18nProvider>
        <FileTree
          rootPath="/workspace"
          directoriesOnly
          selectedFilePath={null}
          onFileSelect={vi.fn()}
          onDirectoryRoot={onDirectoryRoot}
        />
      </I18nProvider>,
    );

    expect(screen.queryByText('notes.txt')).toBeNull();
    await user.click(screen.getByText('project'));
    expect(onDirectoryRoot).toHaveBeenCalledWith('/workspace/project');
  });

  it('anchors an expanded directory action menu to its own row', async () => {
    const user = userEvent.setup();
    useSidebarStore.setState({
      selectedFilePath: null,
      expandedPaths: new Set(['/workspace/project']),
      directoryCache: new Map([
        ['/workspace', [{ name: 'project', path: '/workspace/project', type: 'directory', expanded: true, loaded: true, children: [] }]],
        ['/workspace/project', [{ name: 'child.txt', path: '/workspace/project/child.txt', type: 'file', expanded: false, loaded: true }]],
      ]),
    });

    await renderFixture(
      <I18nProvider>
        <FileTree
          rootPath="/workspace"
          selectedFilePath={null}
          onFileSelect={vi.fn()}
          onDirectoryPinToggle={vi.fn()}
        />
      </I18nProvider>,
    );

    const directoryRow = screen.getByTitle('/workspace/project');
    const childRow = screen.getByTitle('/workspace/project/child.txt');
    await user.click(screen.getByTitle('More folder actions'));

    const menu = screen.getByRole('button', { name: 'Pin' }).parentElement;
    expect(menu?.parentElement?.parentElement).toBe(directoryRow);
    expect(directoryRow.parentElement?.contains(childRow)).toBe(false);
  });

  it('starts a scoped search directly from a directory action', async () => {
    const user = userEvent.setup();
    const onSearchFromDirectory = vi.fn();
    useSidebarStore.setState({
      selectedFilePath: null,
      expandedPaths: new Set(),
      directoryCache: new Map([['/workspace', [
        { name: 'src', path: '/workspace/src', type: 'directory', expanded: false, loaded: true, children: [] },
      ]]]),
    });

    await renderFixture(
      <I18nProvider>
        <FileTree
          rootPath="/workspace"
          selectedFilePath={null}
          onFileSelect={vi.fn()}
          onSearchFromDirectory={onSearchFromDirectory}
        />
      </I18nProvider>,
    );

    await user.click(screen.getByTitle('More folder actions'));
    await user.click(screen.getByRole('button', { name: 'Search from here' }));
    expect(onSearchFromDirectory).toHaveBeenCalledWith('/workspace/src');
  });

  it('opens directory actions directly from a desktop context menu', async () => {
    const onSearchFromDirectory = vi.fn();
    useSidebarStore.setState({
      selectedFilePath: null,
      expandedPaths: new Set(),
      directoryCache: new Map([['/workspace', [
        { name: 'src', path: '/workspace/src', type: 'directory', expanded: false, loaded: true, children: [] },
      ]]]),
    });

    await renderFixture(
      <I18nProvider>
        <FileTree
          rootPath="/workspace"
          selectedFilePath={null}
          onFileSelect={vi.fn()}
          onSearchFromDirectory={onSearchFromDirectory}
        />
      </I18nProvider>,
    );

    const directoryRow = screen.getByTitle('/workspace/src');
    const touchLongPressEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    const contextMenuEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: 240,
      clientY: 180,
    });

    expect(directoryRow.dispatchEvent(touchLongPressEvent)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Search from here' })).toBeNull();
    expect(directoryRow.dispatchEvent(contextMenuEvent)).toBe(false);
    const searchAction = await screen.findByRole('button', { name: 'Search from here' });
    const menu = searchAction.parentElement as HTMLElement;
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.left).toBe('240px');
    expect(menu.style.top).toBe('180px');

    directoryRow.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: window.innerWidth - 1,
      clientY: window.innerHeight - 1,
    }));
    await waitFor(() => {
      expect(Number.parseFloat(menu.style.left) + 176).toBeLessThanOrEqual(window.innerWidth - 8);
      expect(Number.parseFloat(menu.style.top)).toBeLessThan(window.innerHeight - 160);
    });
  });

  it('applies recent-change sorting only to the selected directory', async () => {
    const user = userEvent.setup();
    useSidebarStore.setState({
      selectedFilePath: null,
      expandedPaths: new Set(['/workspace/project']),
      fileSortModes: {},
      directoryCache: new Map([
        ['/workspace', [{ name: 'project', path: '/workspace/project', type: 'directory', expanded: true, loaded: true, children: [] }]],
        ['/workspace/project', [{ name: 'archive.md', path: '/workspace/project/archive.md', type: 'file', expanded: false, loaded: true }]],
      ]),
    });

    await renderFixture(
      <I18nProvider>
        <FileTree
          rootPath="/workspace"
          selectedFilePath={null}
          onFileSelect={vi.fn()}
          onDirectoryPinToggle={vi.fn()}
        />
      </I18nProvider>,
    );

    await user.click(screen.getByTitle('More folder actions'));
    await user.click(screen.getByRole('button', { name: 'Sort by recent changes' }));

    await waitFor(() => expect(useSidebarStore.getState().fileSortModes).toEqual({ '/workspace/project': 'modified' }));
    expect(screen.getByLabelText('Sorted by recent changes')).toBeTruthy();
    expect(updateSettingsMock).toHaveBeenCalledWith({
      fileSortMode: { path: '/workspace/project', mode: 'modified' },
    });
    await waitFor(() => expect(listDirectoryMock).toHaveBeenCalledWith(
      '/workspace/project',
      expect.any(AbortSignal),
      false,
      'expand_directory',
      'file-tree:/workspace/project',
      'modified',
      '/workspace',
    ));
  });
});
