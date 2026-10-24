// @vitest-environment jsdom
import { useRef } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatUserContent } from './ChatTimeline';
import { ChatRichEditor, readChatEditor } from './ChatRichEditor';
import { composeChatDraft } from './chatComposerContent';
import { SessionCapabilitiesContext, ShareAccessContext } from '../../federation/ShareAccessContext';
import { sharedSessionCapabilities } from '../../federation/sessionCapabilities';
const originalWorker = navigator.serviceWorker;
const files = [{ path: '/tmp/演示 #1.mp4', name: '演示 #1.mp4', reference: '视频1', type: 'video/mp4' }];
const text = '看看【视频1】这里';
function Editor() {
  const input = useRef<HTMLDivElement>(null);
  return <ChatRichEditor input={input} value={text} files={files} mentions={[]} placeholder="输入" label="视频草稿" onInput={() => {}} onKeyDown={() => {}} onPaste={() => {}} onFocus={() => {}} onTokenRemove={() => {}} />;
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://localhost/video');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response('video bytes', { headers: { 'Content-Type': 'video/mp4' } })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: originalWorker }); });
it.each(['editor', 'sent', 'legacy'])('opens a video from %s using the existing player and encrypted page fetch without a worker', async stage => {
  render(<>{stage === 'editor' ? <Editor /> : <ChatUserContent content={stage === 'legacy' ? '/tmp/演示\\ #1.mp4 看看这里' : composeChatDraft(text, files, [])} />}</>);
  const button = screen.getByRole('button', { name: '预览视频 演示 #1.mp4' });
  expect(button.textContent).toBe('视频1');
  fireEvent.click(button);
  await screen.findByRole('dialog', { name: '视频预览' });
  const video = await screen.findByTestId('file-preview-video');
  expect(video.getAttribute('src')).toBeNull();
  await waitFor(() => expect(video.getAttribute('src')).toBe('blob:http://localhost/video'), { timeout: 4000 });
  expect(vi.mocked(fetch).mock.calls.some(([url]) => new URL(String(url), location.origin).searchParams.get('path') === '/tmp/演示 #1.mp4')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '关闭视频预览' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  if (stage === 'editor') expect(readChatEditor(screen.getByRole('textbox')).text).toBe(text);
});
it('does not enable video preview in a shared session without explicit file access', () => {
  render(<ShareAccessContext.Provider value={{}}><SessionCapabilitiesContext.Provider value={sharedSessionCapabilities({ canWrite: true })}><><Editor /><ChatUserContent content={composeChatDraft(text, files, [])} /></></SessionCapabilitiesContext.Provider></ShareAccessContext.Provider>);
  expect(screen.queryByRole('button', { name: /预览视频/ })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it('shows a retryable load error without assigning a business URL to native video', async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(new Response('video', { headers: { 'Content-Type': 'video/mp4' } }));
  render(<ChatUserContent content={composeChatDraft('【视频1】', files, [])} />);
  fireEvent.click(screen.getByRole('button', { name: '预览视频 演示 #1.mp4' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('视频加载失败'), { timeout: 4000 });
  expect(document.querySelector('video[src^="/api/"]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重试加载视频' }));
  await waitFor(() => expect(screen.getByTestId('file-preview-video').getAttribute('src')).toBe('blob:http://localhost/video'), { timeout: 4000 });
  fireEvent.click(screen.getByRole('button', { name: '关闭视频预览' }));
});
