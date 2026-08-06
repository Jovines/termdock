// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildVideoPreviewUrl } from '../../terminal/api';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { FilePreview } from './RightSidebar';

const { readFileContentMock } = vi.hoisted(() => ({
  readFileContentMock: vi.fn(async () => ({
    path: '',
    content: '',
    size: 0,
    modified: '',
    binary: true,
  })),
}));

const noop = () => {};
const noopInsert = (_text: string) => {};

vi.mock('../../terminal/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../terminal/api')>()),
  readFileContent: readFileContentMock,
}));

function renderFilePreview(filePath: string) {
  return render(
    <FilePreview
      filePath={filePath}
      onInsertReference={noop}
      onInsertText={noopInsert}
      onInsertFeature={noopInsert}
      onReferenceCopied={noop}
      isMobile={false}
      markdownOutlineOpen={false}
      markdownImageLightboxOpen={false}
      lineRange={null}
      onLineRangeChange={noop}
      insertedReferenceKey={null}
      copiedReferenceKey={null}
    />,
  );
}

describe('RightSidebar video preview', () => {
  const originalFetch = globalThis.fetch;
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    useSidebarStore.setState({ rootPath: '/repo' });
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    // FilePreview 内部埋点会 POST /api/client-log；mock 掉避免真实网络。
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    globalThis.ResizeObserver = originalResizeObserver;
    readFileContentMock.mockClear();
  });

  it('renders a native <video> player for video files without reading them as text', () => {
    renderFilePreview('clips/demo.mp4');
    const video = screen.getByTestId('file-preview-video');
    expect(video.tagName).toBe('VIDEO');
    expect(video.getAttribute('controls')).not.toBeNull();
    expect(video.getAttribute('src')).toBe(buildVideoPreviewUrl('/repo/clips/demo.mp4'));
    expect(readFileContentMock).not.toHaveBeenCalled();
  });

  it('leaves unsupported binary files on the binary hint path', () => {
    renderFilePreview('clips/demo.mkv');
    expect(screen.queryByTestId('file-preview-video')).toBeNull();
    expect(readFileContentMock).toHaveBeenCalled();
  });
});
