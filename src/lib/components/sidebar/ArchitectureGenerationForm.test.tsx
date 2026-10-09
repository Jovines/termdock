// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analysisFile, DEFAULT_ANALYSIS } from '../../architecture/model';
import { ArchitectureGenerationForm } from './ArchitectureGenerationForm';

const initial = { ...DEFAULT_ANALYSIS, kind: 'feature' as const, target: 'File upload', focus: 'Preserve cancellation' };
const props = () => ({ rootPath: '/project', initial, onInsertPrompt: vi.fn().mockResolvedValue(true), onPrepared: vi.fn(), onClose: vi.fn() });
const deferred = () => {
  let resolve!: (value: boolean) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('architecture prompt insertion acknowledgement', () => {
  it('waits for a successful insertion and blocks duplicate submit and copy while pending', async () => {
    const response = deferred(), input = props();
    input.onInsertPrompt.mockReturnValue(response.promise);
    render(<ArchitectureGenerationForm {...input} />);
    const submit = screen.getByRole('button', { name: 'Insert prompt' });
    const form = submit.closest('form')!;
    fireEvent.click(submit);
    fireEvent.submit(form);
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(input.onInsertPrompt).toHaveBeenCalledOnce());
    expect(input.onInsertPrompt).toHaveBeenCalledWith(expect.stringContaining('File upload'), form);
    expect((screen.getByRole('button', { name: 'Adding to the current input…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Copy prompt' }) as HTMLButtonElement).disabled).toBe(true);
    expect(input.onPrepared).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => response.resolve(true));
    expect(input.onPrepared).toHaveBeenCalledExactlyOnceWith(analysisFile(initial), initial);
    expect(screen.getByRole('status').textContent).toContain('Review the current input');
    expect((screen.getByRole('button', { name: 'Insert prompt' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['false', 'rejection'] as const)('retains the form and selection after %s, and permits retry', async outcome => {
    const response = deferred(), input = props();
    input.onInsertPrompt.mockReturnValueOnce(response.promise).mockResolvedValueOnce(true);
    render(<ArchitectureGenerationForm {...input} />);
    fireEvent.click(screen.getByRole('button', { name: 'Insert prompt' }));
    await waitFor(() => expect(input.onInsertPrompt).toHaveBeenCalledOnce());
    await act(async () => { if (outcome === 'false') response.resolve(false); else response.reject(new Error('Disconnected')); });
    expect(input.onPrepared).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('Could not add the prompt');
    expect((screen.getByRole('textbox', { name: 'Feature to understand' }) as HTMLInputElement).value).toBe(initial.target);
    fireEvent.click(screen.getByText('Dependencies and other options'));
    expect((screen.getByRole('textbox', { name: 'Focus and constraints (optional)' }) as HTMLTextAreaElement).value).toBe(initial.focus);
    fireEvent.click(screen.getByRole('button', { name: 'Insert prompt' }));
    await waitFor(() => expect(input.onPrepared).toHaveBeenCalledOnce());
    expect(input.onInsertPrompt).toHaveBeenCalledTimes(2);
  });

  it('ignores a late success after cancellation and reopening the form', async () => {
    const response = deferred(), input = props();
    input.onInsertPrompt.mockReturnValue(response.promise);
    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? <ArchitectureGenerationForm {...input} onClose={() => { input.onClose(); setOpen(false); }} /> : <button onClick={() => setOpen(true)}>Reopen</button>;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Insert prompt' }));
    await waitFor(() => expect(input.onInsertPrompt).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Close analysis settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await act(async () => response.resolve(true));
    expect(input.onClose).toHaveBeenCalledOnce();
    expect(input.onPrepared).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Insert prompt' })).toBeTruthy();
  });

  it('ignores a late success after hiding and reactivating the same form', async () => {
    const response = deferred(), input = props();
    input.onInsertPrompt.mockReturnValue(response.promise);
    const view = render(<ArchitectureGenerationForm {...input} />);
    fireEvent.click(screen.getByRole('button', { name: 'Insert prompt' }));
    await waitFor(() => expect(input.onInsertPrompt).toHaveBeenCalledOnce());
    view.rerender(<ArchitectureGenerationForm {...input} active={false} />);
    view.rerender(<ArchitectureGenerationForm {...input} active />);
    await act(async () => response.resolve(true));
    expect(input.onPrepared).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByRole('button', { name: 'Insert prompt' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not advance after an insertion resolves following unmount', async () => {
    const response = deferred(), input = props();
    input.onInsertPrompt.mockReturnValue(response.promise);
    const view = render(<ArchitectureGenerationForm {...input} />);
    fireEvent.click(screen.getByRole('button', { name: 'Insert prompt' }));
    await waitFor(() => expect(input.onInsertPrompt).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => response.resolve(true));
    expect(input.onPrepared).not.toHaveBeenCalled();
  });

  it('does not insert when the form is canceled in the same tick as submission', async () => {
    const input = props();
    const view = render(<ArchitectureGenerationForm {...input} />);
    const form = screen.getByRole('button', { name: 'Insert prompt' }).closest('form')!;
    await act(async () => {
      fireEvent.submit(form);
      view.unmount();
    });
    expect(input.onInsertPrompt).not.toHaveBeenCalled();
    expect(input.onPrepared).not.toHaveBeenCalled();
  });

  it('only advances the new request when fields change while an earlier insertion is pending', async () => {
    const oldResponse = deferred(), newResponse = deferred(), input = props();
    input.onInsertPrompt.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    render(<ArchitectureGenerationForm {...input} />);
    fireEvent.click(screen.getByRole('button', { name: 'Insert prompt' }));
    await waitFor(() => expect(input.onInsertPrompt).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByRole('textbox', { name: 'Feature to understand' }), { target: { value: 'Download cancellation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert prompt' }));
    await waitFor(() => expect(input.onInsertPrompt).toHaveBeenCalledTimes(2));
    await act(async () => oldResponse.resolve(true));
    expect(input.onPrepared).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Adding to the current input…' })).toBeTruthy();
    await act(async () => newResponse.resolve(true));
    expect(input.onPrepared).toHaveBeenCalledExactlyOnceWith(analysisFile({ ...initial, target: 'Download cancellation' }), { ...initial, target: 'Download cancellation' });
  });

  it('preserves the explicit copy route and advances only after the clipboard succeeds', async () => {
    let finish!: () => void;
    const writeText = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const input = props();
    render(<ArchitectureGenerationForm {...input} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('File upload'));
    expect(input.onPrepared).not.toHaveBeenCalled();
    expect(input.onInsertPrompt).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(input.onPrepared).toHaveBeenCalledExactlyOnceWith(analysisFile(initial), initial);
    expect(screen.getByRole('status').textContent).toBe('Prompt copied.');
  });
});
