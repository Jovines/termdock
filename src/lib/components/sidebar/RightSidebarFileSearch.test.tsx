// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { useSidebarStore } from '../../stores/useSidebarStore';
import { FilePreview } from './RightSidebar';
import { ArchitectureInspector } from './ArchitectureInspector';

vi.mock('./HtmlPreviewFrame', () => ({ HtmlPreviewFrame: () => null }));

vi.mock('../../terminal/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../terminal/api')>()),
  readFileContent: vi.fn(async () => ({ path: '/repo/notes.txt', content: 'needle one\nneedle two', size: 21, modified: '', binary: false })),
}));

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');

const props = {
  filePath: '/repo/notes.txt', onReferenceCopied: vi.fn(), onInsertReference: vi.fn(), onInsertText: vi.fn(), onInsertFeature: vi.fn(),
  isMobile: false, markdownOutlineOpen: false, markdownImageLightboxOpen: false,
  lineRange: null, onLineRangeChange: vi.fn(), insertedReferenceKey: null, copiedReferenceKey: null,
};

async function renderPreview(active = true) {
  const view = render(<I18nProvider><FilePreview {...props} active={active} /></I18nProvider>);
  await waitFor(() => expect(view.container.querySelector('[data-file-preview-line]')).toBeTruthy());
  return view;
}
function shortcut(target: Element, key: string, ctrlKey = false) {
  const event = new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('FilePreview keyboard search ownership', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
    useSidebarStore.setState({ rootPath: '/repo' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ width: 300, height: 400 }] as unknown as DOMRectList);
  });
  afterEach(() => {
    cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
    else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  });

  it('handles a focused visible preview and leaves background shortcuts alone', async () => {
    const view = await renderPreview();
    const line = view.container.querySelector<HTMLElement>('[data-file-preview-line]')!;
    line.focus();
    expect(shortcut(line, 'f', true).defaultPrevented).toBe(true);
    await screen.findByRole('searchbox', { name: 'Find in file' });
    const outside = document.createElement('input'); document.body.append(outside); outside.focus();
    for (const key of ['f', 'Escape', 'F3']) expect(shortcut(outside, key, key === 'f').defaultPrevented).toBe(false);
    expect(screen.getByRole('searchbox', { name: 'Find in file' })).toBeTruthy();
    outside.remove();
    view.rerender(<I18nProvider><FilePreview {...props} active={false} /></I18nProvider>);
    for (const key of ['f', 'Escape', 'F3']) expect(shortcut(line, key, key === 'f').defaultPrevented).toBe(false);
  });

  it('respects shortcuts already consumed inside the preview', async () => {
    const view = await renderPreview();
    const line = view.container.querySelector<HTMLElement>('[data-file-preview-line]')!;
    line.focus();
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    event.preventDefault(); line.dispatchEvent(event);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('closes search before the enclosing architecture keyboard layer and leaves IME Escape alone', async () => {
    const dismiss = vi.fn();
    const view = render(<I18nProvider><ArchitectureInspector title="Source reader" stageKey="source" source onClose={dismiss} onDismiss={dismiss}>
      <FilePreview {...props} active />
    </ArchitectureInspector></I18nProvider>);
    await waitFor(() => expect(view.container.querySelector('[data-file-preview-line]')).toBeTruthy());
    const line = view.container.querySelector<HTMLElement>('[data-file-preview-line]')!;
    line.focus();
    fireEvent.keyDown(line, { key: 'f', ctrlKey: true });
    const input = await screen.findByRole('searchbox', { name: 'Find in file' });
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Source reader' })).toBeTruthy();
    expect(dismiss).not.toHaveBeenCalled();
    line.focus();
    fireEvent.keyDown(line, { key: 'f', ctrlKey: true });
    const reopenedInput = await screen.findByRole('searchbox', { name: 'Find in file' });
    reopenedInput.focus();
    fireEvent.keyDown(reopenedInput, { key: 'Escape', isComposing: true });
    expect(screen.getByRole('searchbox')).toBe(reopenedInput);
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.keyDown(reopenedInput, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).toBeNull();
    line.focus();
    fireEvent.keyDown(line, { key: 'Escape' });
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it.each(['inactive', 'hidden', 'focus moved', 'unmounted'])('does not reclaim search focus after %s before its animation frame', async (state) => {
    const view = await renderPreview();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const button = screen.getByRole('button', { name: 'Find in file' }); button.focus();
    fireEvent.click(button);
    const input = await screen.findByRole('searchbox', { name: 'Find in file' });
    if (state === 'inactive') view.rerender(<I18nProvider><FilePreview {...props} active={false} /></I18nProvider>);
    if (state === 'hidden') view.container.hidden = true;
    if (state === 'unmounted') view.unmount();
    const outside = document.createElement('input'); document.body.append(outside); outside.focus();
    frames.forEach((callback) => callback(0));
    expect(document.activeElement).toBe(outside);
    expect(document.activeElement).not.toBe(input);
    outside.remove();
  });
});
