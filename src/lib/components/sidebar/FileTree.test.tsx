// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { FileTree } from './FileTree';

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

const { deleteFileMock } = vi.hoisted(() => ({
  deleteFileMock: vi.fn(async () => undefined),
}));

vi.mock('../../terminal/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../terminal/api')>()),
  deleteFile: deleteFileMock,
}));

describe('FileTree file deletion', () => {
  beforeEach(() => {
    useSidebarStore.setState({
      rootPath: '/workspace',
      selectedFilePath: '/workspace/notes.txt',
      expandedPaths: new Set(),
      directoryCache: new Map([['/workspace', [{
        name: 'notes.txt',
        path: '/workspace/notes.txt',
        type: 'file',
        expanded: false,
        loaded: false,
      }]]]),
    });
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
    vi.unstubAllGlobals();
  });

  it('only deletes after the user confirms the irreversible action', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);

    render(
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

    render(
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
});
