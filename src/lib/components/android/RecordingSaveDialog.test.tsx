// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecordingSaveDialog } from './RecordingSaveDialog';
import { saveAndroidRecording, discardAndroidRecording, type AndroidRecording } from '../../android/api';
vi.mock('../../android/api', () => ({ saveAndroidRecording: vi.fn(), discardAndroidRecording: vi.fn() }));
vi.mock('../sidebar/DirectoryPickerDialog', () => ({
  DirectoryPickerDialog: ({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (path: string) => void }) => <div>
    <button onClick={onCancel}>Cancel folder</button>
    <button onClick={() => onConfirm('/project/videos')}>Choose folder</button>
  </div>,
}));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
beforeEach(() => { vi.mocked(saveAndroidRecording).mockResolvedValue({ path: '/server/recording.mp4' }); });
const file: AndroidRecording = { id: 'rec', name: 'recording.mp4', serial: 'device', size: 1234, startedAt: 0, status: 'ready' };
function setup(item = file) {
  const onInsert = vi.fn(async (_path: string) => {}), onDone = vi.fn();
  render(<RecordingSaveDialog file={item} initialPath="/project" onInsert={onInsert} onDone={onDone} />);
  return { onInsert, onDone };
}
describe('server recording confirmation', () => {
  it('inserts a server path only after explicit selection', async () => {
    const { onInsert, onDone } = setup();
    expect(saveAndroidRecording).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Insert directly'));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(saveAndroidRecording).toHaveBeenCalledWith('rec', undefined);
    expect(onInsert).toHaveBeenCalledWith('/server/recording.mp4');
  });
  it('keeps recording when folder selection is cancelled and saves server-side when confirmed', async () => {
    const { onInsert, onDone } = setup();
    await userEvent.click(screen.getByText('Save to a folder'));
    await userEvent.click(screen.getByText('Cancel folder'));
    expect(saveAndroidRecording).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Save to a folder'));
    await userEvent.click(screen.getByText('Choose folder'));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(saveAndroidRecording).toHaveBeenCalledWith('rec', '/project/videos');
    expect(onInsert).not.toHaveBeenCalled();
  });
  it('retains dialog on network failure and allows retry', async () => {
    vi.mocked(saveAndroidRecording).mockRejectedValueOnce(new Error('Disconnected'));
    const { onDone } = setup();
    await userEvent.click(screen.getByText('Insert directly'));
    expect((await screen.findByRole('alert')).textContent).toBe('Disconnected');
    expect(onDone).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Insert directly'));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });
  it('discards on the server and keeps dialog on discard failure', async () => {
    vi.mocked(discardAndroidRecording).mockRejectedValueOnce(new Error('Offline'));
    const { onDone } = setup();
    await userEvent.click(screen.getByText('Discard recording'));
    expect((await screen.findByRole('alert')).textContent).toBe('Offline');
    expect(onDone).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Discard recording'));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(discardAndroidRecording).toHaveBeenCalledWith('rec');
  });
  it('does not offer a broken recording as a successful artifact', () => {
    setup({ ...file, status: 'error', error: 'Encoder failed' });
    expect(screen.getByRole('alert').textContent).toBe('Encoder failed');
    expect((screen.getByText('Insert directly') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Save to a folder') as HTMLButtonElement).disabled).toBe(true);
  });
});
