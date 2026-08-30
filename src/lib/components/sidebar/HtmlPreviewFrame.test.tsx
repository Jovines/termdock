// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HtmlPreviewFrame } from './HtmlPreviewFrame';

afterEach(() => cleanup());

function renderPreview() {
  return render(
    <HtmlPreviewFrame
      src="/preview/index.html"
      title="index.html preview"
      enterFullscreenLabel="全屏预览"
      exitFullscreenLabel="退出全屏"
    />,
  );
}

describe('HtmlPreviewFrame', () => {
  it('keeps the HTML document sandboxed and exposes the fullscreen action', () => {
    const { container } = renderPreview();
    const iframe = container.querySelector('iframe');

    expect(iframe?.getAttribute('src')).toBe('/preview/index.html');
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(screen.getByRole('button', { name: '全屏预览' })).toBeTruthy();
  });

  it('falls back to an app-level fullscreen overlay and exits with Escape', () => {
    renderPreview();

    fireEvent.click(screen.getByRole('button', { name: '全屏预览' }));
    expect(document.body.querySelector('.fixed.inset-0.z-modal-panel')).toBeTruthy();
    expect(screen.getByRole('button', { name: '退出全屏' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('button', { name: '全屏预览' })).toBeTruthy();
    expect(document.body.querySelector('.fixed.inset-0.z-modal-panel')).toBeNull();
  });
});
