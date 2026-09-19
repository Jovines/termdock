// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecordingSaveDialog } from './RecordingSaveDialog';
import { uploadFiles } from '../../terminal/api';

vi.mock('../../terminal/api', () => ({ uploadFiles: vi.fn() }));
vi.mock('../sidebar/DirectoryPickerDialog', () => ({
  DirectoryPickerDialog: ({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (path: string) => void }) => <div>
    <button onClick={onCancel}>Cancel folder</button>
    <button onClick={() => onConfirm('/project/videos')}>Choose folder</button>
  </div>,
}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const file = new File(['video'], 'recording.mp4', { type: 'video/mp4' });
function setup() {
  const onInsert = vi.fn(async () => {});
  const onDone = vi.fn();
  render(<RecordingSaveDialog file={file} initialPath="/project" onInsert={onInsert} onDone={onDone} />);
  return { onInsert, onDone };
}
describe('录屏二次确认', () => {
  it('插入期间显示 loading、禁用重复操作，完成后关闭', async () => {
    const { onInsert, onDone } = setup();
    let finish!: () => void;
    onInsert.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await userEvent.click(screen.getByText('Insert directly'));
    expect(screen.getByRole('status').textContent).toBe('Inserting…');
    expect(screen.getByRole('status').querySelector('.animate-spin')).toBeTruthy();
    expect((screen.getByText('Insert directly') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Save to a folder') as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByText('Insert directly'));
    expect(onInsert).toHaveBeenCalledOnce();
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('保存期间显示保存状态', async () => {
    let finish!: (value: { files: { name: string; path: string; size: number }[] }) => void;
    vi.mocked(uploadFiles).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { onDone } = setup();
    await userEvent.click(screen.getByText('Save to a folder'));
    await userEvent.click(screen.getByText('Choose folder'));
    expect(screen.getByRole('status').textContent).toBe('Saving recording…');
    await act(async () => finish({ files: [{ name: file.name, path: '/project/videos/recording.mp4', size: file.size }] }));
    expect(onDone).toHaveBeenCalledOnce();
  });
  it('等待明确选择后才插入', async () => {
    const { onInsert, onDone } = setup();
    expect(onInsert).not.toHaveBeenCalled();
    expect(uploadFiles).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Insert directly'));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(onInsert).toHaveBeenCalledWith(file);
    expect(uploadFiles).not.toHaveBeenCalled();
  });
  it('取消选目录保留录屏，重选后仅保存不插入', async () => {
    vi.mocked(uploadFiles).mockResolvedValue({ files: [{ name: file.name, path: '/project/videos/recording.mp4', size: file.size }] });
    const { onInsert, onDone } = setup();
    await userEvent.click(screen.getByText('Save to a folder'));
    await userEvent.click(screen.getByText('Cancel folder'));
    expect(onDone).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Save to a folder'));
    await userEvent.click(screen.getByText('Choose folder'));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(uploadFiles).toHaveBeenCalledWith('/project/videos', [file]);
    expect(onInsert).not.toHaveBeenCalled();
  });
  it('保存失败后保留文件并允许重试', async () => {
    vi.mocked(uploadFiles).mockRejectedValue(new Error('Disconnected'));
    const { onDone, onInsert } = setup();
    await userEvent.click(screen.getByText('Save to a folder'));
    await userEvent.click(screen.getByText('Choose folder'));
    expect((await screen.findByRole('alert')).textContent).toBe('Disconnected');
    expect(onDone).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Insert directly'));
    await waitFor(() => expect(onInsert).toHaveBeenCalledWith(file));
  });
  it('插入失败保留文件，丢弃不上传', async () => {
    const { onInsert, onDone } = setup();
    onInsert.mockRejectedValueOnce(new Error('Insert failed'));
    await userEvent.click(screen.getByText('Insert directly'));
    expect((await screen.findByRole('alert')).textContent).toBe('Insert failed');
    expect(onDone).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Discard recording'));
    expect(onDone).toHaveBeenCalledOnce();
    expect(uploadFiles).not.toHaveBeenCalled();
  });
});
