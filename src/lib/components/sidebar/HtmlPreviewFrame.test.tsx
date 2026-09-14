// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HtmlPreviewFrame, type HtmlPreviewFrameHandle } from './HtmlPreviewFrame';

vi.mock('../../federation/browserIntegration', () => ({ getActiveClient: async () => ({ fetch: vi.fn() }) }));
const { attach, detach } = vi.hoisted(() => ({ attach: vi.fn(), detach: vi.fn() }));
vi.mock('../../federation/secureHtmlPreview', () => ({ prepareSecureHtmlPreview: async () => ({ html: '<!doctype html><p>Safe preview</p>', shellUrl: '/preview-shell.html#test', errors: [], attach: attach.mockImplementation(() => detach), dispose: () => {} }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderPreview() {
  const ref = createRef<HtmlPreviewFrameHandle>();
  return render(
    <>
      <button type="button" onClick={() => void ref.current?.toggleFullscreen()}>全屏预览</button>
      <HtmlPreviewFrame
        ref={ref}
        src="/preview/index.html"
        title="index.html preview"
        exitFullscreenLabel="退出全屏"
      />
    </>,
  );
}

describe('HtmlPreviewFrame', () => {
  it('keeps the HTML document sandboxed and exposes the fullscreen action', async () => {
    const { container } = renderPreview();
    const iframe = container.querySelector('iframe');

    expect(iframe?.getAttribute('src')).toBeNull();
    await waitFor(() => expect(iframe?.getAttribute('src')).toBe('/preview-shell.html#test'));
    expect(iframe?.getAttribute('srcdoc')).toBeNull();
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe?.parentElement?.querySelector('button')).toBeNull();
  });

  it('falls back to an app-level fullscreen overlay and exits with Escape', () => {
    renderPreview();

    fireEvent.click(screen.getByRole('button', { name: '全屏预览' }));
    expect(document.body.querySelector('.fixed.inset-0.z-modal-panel')).toBeTruthy();
    expect(screen.getByRole('button', { name: '退出全屏' })).toBeTruthy();
    expect(screen.getByText('index.html preview')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('button', { name: '全屏预览' })).toBeTruthy();
    expect(document.body.querySelector('.fixed.inset-0.z-modal-panel')).toBeNull();
  });

  it('rebinds the resource bridge when fullscreen replaces the iframe, in both directions', async () => {
    const { container } = renderPreview();
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
    const original = container.querySelector('iframe');

    fireEvent.click(screen.getByRole('button', { name: '全屏预览' }));
    const fullscreen = document.body.querySelector('.fixed iframe');
    expect(fullscreen).not.toBe(original);
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(attach).toHaveBeenLastCalledWith(fullscreen, expect.any(Function)));
    expect(detach).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    const restored = container.querySelector('iframe');
    expect(restored).not.toBe(fullscreen);
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(attach).toHaveBeenLastCalledWith(restored, expect.any(Function)));
    expect(detach).toHaveBeenCalledTimes(2);
  });
});
