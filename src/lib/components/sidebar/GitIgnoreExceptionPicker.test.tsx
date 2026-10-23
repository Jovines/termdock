// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitIgnoreExceptionPicker } from './GitIgnoreExceptionPicker';

const { list, cancel } = vi.hoisted(() => ({ list: vi.fn(), cancel: vi.fn() }));
vi.mock('../../terminal/api', () => ({ listDirectory: list, cancelIoSlot: cancel }));
beforeEach(() => { list.mockReset(); cancel.mockReset(); });
afterEach(cleanup);

describe('Git ignore exception browsing', () => {
  it('keeps selections relative to a symlink root and leaves ignored and hidden files visible', async () => {
    list.mockResolvedValueOnce({ path: '/real/project', entries: [{ name: '.cache', path: '/real/project/.cache', type: 'directory' }] })
      .mockResolvedValueOnce({ path: '/real/project/.cache', entries: [{ name: 'data', path: '/real/project/.cache/data', type: 'file' }] });
    const change = vi.fn();
    render(<GitIgnoreExceptionPicker rootPath="/linked/project/" paths={['.cache/']} disabled={false} onChange={change} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open folder .cache' }));
    const checkbox = await screen.findByRole('checkbox', { name: 'data' });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect((checkbox as HTMLInputElement).disabled).toBe(true);
    expect(list.mock.calls.map(call => call[0])).toEqual(['/linked/project', '/linked/project/.cache']);
    expect(list.mock.calls.every(call => call[2] === true && call[6] === undefined)).toBe(true);
    expect(change).not.toHaveBeenCalled();
  });

  it('resets browsing when the project changes and uses shared retry behavior', async () => {
    list.mockResolvedValueOnce({ entries: [{ name: 'src', type: 'directory' }] })
      .mockResolvedValueOnce({ entries: [] })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ entries: [{ name: 'fresh.txt', type: 'file' }] });
    const change = vi.fn();
    const view = render(<GitIgnoreExceptionPicker rootPath="/first" paths={[]} disabled={false} onChange={change} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open folder src' }));
    await screen.findByText('This folder is empty');
    view.rerender(<GitIgnoreExceptionPicker rootPath="/second" paths={[]} disabled={false} onChange={change} />);
    await screen.findByRole('alert');
    expect(list.mock.calls[2][0]).toBe('/second');
    expect((screen.getByRole('button', { name: 'Parent folder' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'fresh.txt' }));
    await waitFor(() => expect(change).toHaveBeenCalledWith(['fresh.txt']));
  });
});
