// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollaborationInput } from './CollaborationInput';
import { routeCollaborationInput } from '../../collaboration/inputTarget';
const state = vi.hoisted(() => ({ upload: vi.fn(),
  bridge: null as { readClipboardFiles?: ReturnType<typeof vi.fn>; readClipboardImage?: ReturnType<typeof vi.fn> } | null,
  target: { targetPeerId: 'service-a', serviceOrigin: 'https://service-a' },
}));
vi.mock('../../terminal/api', () => ({ uploadFiles: state.upload }));
vi.mock('../../desktop/nativeBridge', () => ({ getTermdockDesktopBridge: () => state.bridge }));
vi.mock('../../federation/clientScope', () => ({ selectedTarget: () => state.target }));
beforeEach(() => {
  vi.clearAllMocks(); state.bridge = null; state.target = { targetPeerId: 'service-a', serviceOrigin: 'https://service-a' };
  state.upload.mockImplementation(async (_dir: string, files: File[]) => ({ files: files.map(f => ({ name: f.name, path: `/tmp/${f.name}`, size: f.size })) }));
});
afterEach(cleanup);
function setup(initial = '', onUploadChange = vi.fn()) {
  function Draft({ active = true }: { active?: boolean }) {
    const [text, setText] = useState(initial);
    return <CollaborationInput inputKey="test-draft" label="补充说明" value={text} onChange={setText} active={active} onUploadChange={onUploadChange} />;
  }
  return { ...render(<Draft />), Draft, onUploadChange, field: screen.getByRole('textbox', { name: '补充说明' }) as HTMLTextAreaElement };
}
function paste(field: HTMLElement, files: File[] = [], text = '') {
  return fireEvent.paste(field, { clipboardData: { files, items: [], getData: () => text } });
}
it('uploads a browser file and inserts its escaped service path at the caret', async () => {
  const { field, onUploadChange } = setup('前文 后文');
  field.focus(); field.setSelectionRange(3, 3);
  const file = new File(['content'], 'file with spaces.txt', { type: 'text/plain' });
  expect(paste(field, [file])).toBe(false);
  await waitFor(() => expect(field.value).toBe(String.raw`前文 /tmp/file\ with\ spaces.txt 后文`));
  expect(state.upload).toHaveBeenCalledWith('/tmp', [file]);
  expect(onUploadChange.mock.calls).toEqual([[1], [-1]]);
});
it('gives pasted screenshots unique upload names instead of overwriting image.png', async () => {
  const { field } = setup();
  const image = new File(['png'], 'image.png', { type: 'image/png' });
  paste(field, [image]);
  await waitFor(() => expect(state.upload).toHaveBeenCalledOnce());
  paste(field, [image]);
  await waitFor(() => expect(state.upload).toHaveBeenCalledTimes(2));
  const names = state.upload.mock.calls.map(call => (call[1] as File[])[0].name);
  expect(names[0]).toMatch(/^termdock-clipboard-.*\.png$/);
  expect(names[1]).not.toBe(names[0]);
});
it('keeps newer typing when an upload finishes later', async () => {
  let finish!: (result: { files: { name: string; path: string; size: number }[] }) => void;
  state.upload.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { field } = setup('原文');
  paste(field, [new File(['file'], 'notes.txt')]);
  await screen.findByRole('status');
  fireEvent.change(field, { target: { value: '原文和后写的内容' } });
  await act(async () => finish({ files: [{ name: 'notes.txt', path: '/tmp/notes.txt', size: 4 }] }));
  expect(field.value).toBe('原文和后写的内容\n/tmp/notes.txt ');
});
it('supports the file picker and drops without sending or clearing the draft', async () => {
  const { field } = setup('说明');
  fireEvent.change(screen.getByLabelText('选择附件：补充说明'), { target: { files: [new File(['a'], 'a.txt')] } });
  await waitFor(() => expect(field.value).toContain('/tmp/a.txt'));
  fireEvent.drop(field, { dataTransfer: { files: [new File(['b'], 'b.pdf')] } });
  await waitFor(() => expect(field.value).toContain('/tmp/b.pdf'));
  expect(field.value).toContain('说明');
});
it('reports upload failures and incomplete path responses without discarding text', async () => {
  const { field } = setup('不要丢掉这段');
  state.upload.mockRejectedValueOnce(new Error('附件上传失败'));
  paste(field, [new File(['a'], 'a.txt')]);
  expect((await screen.findByRole('alert')).textContent).toBe('附件上传失败');
  expect(field.value).toBe('不要丢掉这段');
  state.upload.mockResolvedValueOnce({ files: [] });
  paste(field, [new File(['a'], 'a.txt')]);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('附件上传未返回完整路径'));
  expect(field.value).toBe('不要丢掉这段');
});
it('uses native file bytes for remote upload and verified local paths without reupload', async () => {
  const reader = vi.fn().mockResolvedValueOnce([{ name: 'remote.txt', bytes: new Uint8Array([1]).buffer }])
    .mockResolvedValueOnce([{ name: 'local.txt', path: '/local/local.txt' }]);
  state.bridge = { readClipboardFiles: reader };
  const { field } = setup();
  paste(field);
  await waitFor(() => expect(field.value).toContain('/tmp/remote.txt'));
  expect(reader).toHaveBeenCalledWith({ localServiceId: 'service-a' });
  paste(field);
  await waitFor(() => expect(field.value).toContain('/local/local.txt'));
  expect(state.upload).toHaveBeenCalledOnce();
});
it('never substitutes a video cover image after a recognized native video failure', async () => {
  state.bridge = { readClipboardFiles: vi.fn().mockRejectedValue(new Error('TERMDOCK_CLIPBOARD_VIDEO_ERROR:无法读取剪贴板视频')) };
  const { field } = setup('说明');
  paste(field, [new File(['cover'], 'cover.png', { type: 'image/png' })], '视频标题');
  expect((await screen.findByRole('alert')).textContent).toContain('无法读取剪贴板视频');
  expect(state.upload).not.toHaveBeenCalled(); expect(field.value).toBe('说明');
});
it('routes file references to the focused draft and releases the receiver when hidden', async () => {
  const { field, rerender, Draft } = setup('说明 ');
  field.focus(); field.setSelectionRange(3, 3);
  act(() => { expect(routeCollaborationInput('/project/example.ts')).toBe(true); });
  expect(field.value).toBe('说明 /project/example.ts');
  rerender(<Draft active={false} />);
  expect(routeCollaborationInput('不要写入隐藏草稿')).toBe(false);
});
it('blocks inserting clipboard paths if the target changes during native reading', async () => {
  let finish!: (files: { name: string; path: string }[]) => void;
  state.bridge = { readClipboardFiles: vi.fn().mockReturnValue(new Promise(resolve => { finish = resolve; })) };
  const { field } = setup('原文');
  paste(field);
  await screen.findByRole('status');
  state.target = { targetPeerId: 'service-b', serviceOrigin: 'https://service-b' };
  await act(async () => finish([{ name: 'a.txt', path: '/local/a.txt' }]));
  expect(screen.getByRole('alert').textContent).toContain('目标服务已切换');
  expect(field.value).toBe('原文'); expect(state.upload).not.toHaveBeenCalled();
});
