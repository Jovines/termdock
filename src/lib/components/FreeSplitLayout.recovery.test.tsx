// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FreeSplitLayout } from './FreeSplitLayout';
import { collaborationPanelClientId } from '../collaboration/panelPreferences';
import { SECURE_READY_EVENT } from '../federation/connectionRecovery';
const api = vi.hoisted(() => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));
vi.mock('../terminal/api', () => api);
beforeEach(() => { vi.useFakeTimers(); api.getSettings.mockReset().mockResolvedValue({}); api.updateSettings.mockReset().mockResolvedValue({}); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const panes = ['a', 'b'].map(id => ({ id, content: <div>{id}</div> }));
const saved = { collaborationPanels: { [collaborationPanelClientId()]: { layouts: { recover: { axis: 'x', ratio: 0.7, first: { id: 'a' }, second: { id: 'b' } } } } } };
it('retries first-load failure without refresh and restores the saved geometry', async () => {
  api.getSettings.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(saved);
  const view = render(<FreeSplitLayout layoutId="recover" panes={panes} />);
  await act(async () => {});
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByRole('separator') as HTMLButtonElement).disabled).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(view.container.querySelector<HTMLElement>('[data-layout-pane="a"]')!.style.width).toBe('70%');
  expect(api.getSettings).toHaveBeenCalledTimes(2);
});
it('keeps adjustments made during an outage and saves the latest geometry after secure-ready', async () => {
  api.getSettings.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(saved);
  const view = render(<FreeSplitLayout layoutId="recover" panes={panes} />);
  await act(async () => {});
  fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
  await act(async () => {});
  const width = view.container.querySelector<HTMLElement>('[data-layout-pane="a"]')!.style.width;
  expect(width).toBe('47%');
  expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ collaborationPanel: expect.objectContaining({ state: { layouts: { recover: expect.objectContaining({ ratio: 0.47 }) } } }) }));
  expect(view.container.querySelector<HTMLElement>('[data-layout-pane="a"]')!.style.width).toBe(width);
});
it('retries saving without another adjustment and cancels timers on unmount', async () => {
  api.updateSettings.mockRejectedValueOnce(new TypeError('offline'));
  const view = render(<FreeSplitLayout layoutId="recover" panes={panes} />);
  await act(async () => {});
  fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
  await act(async () => {});
  expect(api.updateSettings).toHaveBeenCalledTimes(1);
  await act(async () => { window.dispatchEvent(new Event(SECURE_READY_EVENT)); });
  expect(api.updateSettings).toHaveBeenCalledTimes(2);
  view.unmount();
  const calls = api.updateSettings.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(api.updateSettings).toHaveBeenCalledTimes(calls);
});
