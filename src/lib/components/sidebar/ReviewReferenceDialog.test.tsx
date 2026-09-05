// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewReferenceDialog, type PendingReviewReference } from './ReviewReferenceDialog';
import { formatReviewReference, modelFitDistance } from './reviewReference';
import { useReviewReferenceStore } from './reviewReferenceStore';
const { uploadMock } = vi.hoisted(() => ({ uploadMock: vi.fn() }));
vi.mock('../../terminal/api', () => ({ uploadFiles: uploadMock }));
const source: PendingReviewReference = { text: '电子标注: /repo/board.kicad_pcb / J1 / (1,2)mm', key: 'j1', capturedAt: '2026-09-05T10:00:00Z' };
const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
beforeEach(() => {
  uploadMock.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:snapshot');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { cleanup(); URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; });
function setup(reference = source, draftEnabled = false) {
  const onInsert = vi.fn(), onCancel = vi.fn();
  const result = render(<ReviewReferenceDialog reference={reference} draftEnabled={draftEnabled} onInsert={onInsert} onCancel={onCancel} />);
  return { ...result, onInsert, onCancel };
}
describe('review reference', () => {
  it('retains page-only comments across remounts and clears them on cancel', () => {
    const store = useReviewReferenceStore;
    store.getState().open(source, 'original-session');
    const props = { reference: source, draftEnabled: false, onInsert: vi.fn(), onCancel: store.getState().close, onNoteChange: store.getState().setNote };
    const first = render(<ReviewReferenceDialog {...props} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep across resizing' } });
    first.unmount();
    render(<ReviewReferenceDialog {...props} initialNote={store.getState().note} targetChanged />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep across resizing');
    expect((screen.getByRole('button', { name: 'Insert reference' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Insert reference' }));
    expect(props.onInsert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(store.getState().pending).toBe(null);
    expect(store.getState().note).toBe('');
  });
  it('renders inside native fullscreen and returns to the body on exit', () => {
    const fullscreen = document.createElement('div');
    document.body.append(fullscreen);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: fullscreen });
    const result = setup();
    expect(fullscreen.contains(screen.getByRole('dialog'))).toBe(true);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    fireEvent(document, new Event('fullscreenchange'));
    expect(fullscreen.contains(screen.getByRole('dialog'))).toBe(false);
    result.unmount(); fullscreen.remove();
  });
  it('previews locally and cancels without uploads or terminal insertion', async () => {
    const result = setup({ ...source, snapshot: Promise.resolve(new Blob(['image'])) });
    await screen.findByRole('img');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Move this' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(result.onCancel).toHaveBeenCalledOnce();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(result.onInsert).not.toHaveBeenCalled();
    result.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:snapshot');
  });
  it('inserts text and comment, never sends on Enter', async () => {
    const result = setup();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Make this thinner' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
    expect(result.onInsert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Insert reference' }));
    await waitFor(() => expect(result.onInsert).toHaveBeenCalledOnce());
    expect(result.onInsert.mock.calls[0][0]).toContain('审阅意见：Make this thinner');
    expect(uploadMock).not.toHaveBeenCalled();
  });
  it('uploads only on confirmation and uses the returned collision-safe path', async () => {
    uploadMock.mockResolvedValue({ files: [{ path: '/tmp/actual-server-name.png' }] });
    const result = setup({ ...source, snapshot: Promise.resolve(new Blob(['image'])) }, true);
    await screen.findByRole('img');
    expect(uploadMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add to context draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preparing reference…' }));
    await waitFor(() => expect(result.onInsert).toHaveBeenCalledOnce());
    expect(uploadMock).toHaveBeenCalledOnce();
    expect(result.onInsert.mock.calls[0][0]).toContain('/tmp/actual-server-name.png');
    expect(uploadMock.mock.calls[0][0]).toBe('/tmp');
  });
  it('keeps comment on upload failure, allows retry or explicit text-only fallback', async () => {
    uploadMock.mockRejectedValue(new Error('offline'));
    const result = setup({ ...source, snapshot: Promise.resolve(new Blob(['image'])) });
    await screen.findByRole('img');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep my note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert reference' }));
    await screen.findByRole('alert');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep my note');
    expect(result.onInsert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Insert reference' }));
    await waitFor(() => expect(result.onInsert).toHaveBeenCalledOnce());
    expect(result.onInsert.mock.calls[0][0]).not.toContain('审阅截图');
  });
  it('does not insert into another view after an in-flight upload is unmounted', async () => {
    let resolve!: (result: unknown) => void;
    uploadMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    const result = setup({ ...source, snapshot: Promise.resolve(new Blob(['image'])) });
    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'Insert reference' }));
    const signal = uploadMock.mock.calls[0][2] as AbortSignal;
    result.unmount();
    expect(signal.aborted).toBe(true);
    resolve({ files: [{ path: '/tmp/late.png' }] });
    await Promise.resolve();
    expect(result.onInsert).not.toHaveBeenCalled();
  });
  it('fits narrow screens using the horizontal field of view', () => {
    expect(modelFitDistance(20, 45, 0.5)).toBeGreaterThan(modelFitDistance(20, 45, 2));
    expect(Number.isFinite(modelFitDistance(0, 45, 0))).toBe(true);
    expect(formatReviewReference('location', '', 'time')).not.toContain('审阅意见');
  });
});
