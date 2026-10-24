// @vitest-environment jsdom
import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatRichEditor, readChatEditor, setChatEditorCaret } from './ChatRichEditor';
import { ChatUserContent } from './ChatTimeline';
import { composeChatDraft } from './chatComposerContent';
import { SessionCapabilitiesContext } from '../../federation/ShareAccessContext';
import { sharedSessionCapabilities } from '../../federation/sessionCapabilities';
import { clearPreviewResourceCache } from '../../utils/previewResourceCache';
vi.mock('swiper/react', () => ({
  Swiper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SwiperSlide: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('swiper/css', () => ({}));
const files = [{ path: '/tmp/图 #1.png', name: '第一张.png', reference: '图片1' }, { path: '/tmp/two.png', name: '第二张.png', reference: '图片2' }];
const text = '请看【图片1】和【图片2】';
const removed = vi.fn(), editorKeyDown = vi.fn();
function Editor() {
  const input = useRef<HTMLDivElement>(null);
  return <ChatRichEditor input={input} value={text} files={files} mentions={[]} placeholder="输入" label="草稿" onInput={() => {}} onKeyDown={editorKeyDown} onPaste={() => {}} onFocus={() => {}} onTokenRemove={removed} />;
}
beforeEach(() => {
  removed.mockReset(); editorKeyDown.mockReset(); clearPreviewResourceCache();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } })));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://localhost/image');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { cleanup(); clearPreviewResourceCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('opens an editor image without changing the draft or caret, and leaves removal independent', async () => {
  render(<Editor />);
  const editor = screen.getByRole('textbox'); editor.focus(); setChatEditorCaret(editor, 2);
  fireEvent.keyDown(screen.getByRole('button', { name: '预览图片 第一张.png' }), { key: 'Enter' });
  expect(editorKeyDown).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '预览图片 第一张.png' }));
  await screen.findAllByRole('img');
  fireEvent.keyDown(editor, { key: 'Enter' });
  expect(editorKeyDown).not.toHaveBeenCalled();
  expect(readChatEditor(editor)).toMatchObject({ text, start: 2, end: 2 });
  const urls = vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)));
  expect(urls.some(url => url.pathname === '/api/terminal/fs/blob' && url.searchParams.get('path') === files[0].path)).toBe(true);
  expect(screen.getAllByRole('img').every(image => image.getAttribute('src')?.startsWith('blob:'))).toBe(true);
  fireEvent.keyDown(editor, { key: 'Escape' });
  await waitFor(() => expect(document.querySelector('[data-markdown-image-lightbox]')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '移除附件 第一张.png' }));
  expect(removed).toHaveBeenCalledWith('【图片1】');
  expect(document.querySelector('[data-markdown-image-lightbox]')).toBeNull();
});
it('opens sent inline images and older cards, switches images, and closes', async () => {
  const view = render(<ChatUserContent content={composeChatDraft(text, files, [])} />);
  fireEvent.click(screen.getByRole('button', { name: '预览图片 第一张.png' }));
  await screen.findByRole('button', { name: 'Next image' });
  fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
  await waitFor(() => expect(document.querySelector('[data-markdown-image-lightbox]')?.textContent).toContain('2 / 2'));
  fireEvent.click(screen.getByRole('button', { name: 'Close image preview' }));
  view.rerender(<ChatUserContent content={composeChatDraft('', [{ path: '/tmp/legacy.png', name: '旧图.png' }], [])} />);
  fireEvent.click(screen.getByRole('button', { name: '预览图片 旧图.png' }));
  await screen.findByRole('img');
  expect(document.querySelector('[data-markdown-image-lightbox]')?.textContent).toContain('旧图.png');
});
it('retries a failed image load and aborts a closed pending preview without a native image request', async () => {
  let signal: AbortSignal | undefined;
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(async (_url, options) => {
    signal = options?.signal as AbortSignal;
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason)));
  });
  render(<ChatUserContent content={composeChatDraft('【图片1】', [files[0]], [])} />);
  fireEvent.click(screen.getByRole('button', { name: '预览图片 第一张.png' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Failed to load image preview');
  expect(screen.queryByRole('img')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(signal).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: 'Close image preview' }));
  await act(async () => {});
  expect(signal?.aborted).toBe(true);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it('requires file resource capability even when a shared session permits input', () => {
  render(<SessionCapabilitiesContext.Provider value={sharedSessionCapabilities({ canWrite: true })}><Editor /><ChatUserContent content={composeChatDraft(text, files, [])} /></SessionCapabilitiesContext.Provider>);
  expect(screen.queryByRole('button', { name: /预览图片/ })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
