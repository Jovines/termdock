// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StartupScreen } from './StartupScreen';
import { AppFeedbackHost, useAppFeedback, useFeedbackStore } from './ui/AppFeedback';
import { setConnectionRecovery } from '../federation/connectionRecovery';

let surface: HTMLElement;
let root: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  setConnectionRecovery('ready');
  useFeedbackStore.setState({ items: [] });
  surface = document.createElement('div');
  surface.id = 'termdock-startup';
  surface.innerHTML = '<div role="status"><span data-startup-status></span></div><p data-startup-detail hidden></p><button data-startup-action hidden></button>';
  root = document.createElement('div');
  root.id = 'root';
  document.body.append(surface, root);
});
afterEach(() => {
  cleanup();
  surface.remove();
  root.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const advance = async (ms: number) => { await act(() => vi.advanceTimersByTimeAsync(ms)); };

it('uses one recovery status through reconnect, offline, session restore and completion', async () => {
  const view = render(<><StartupScreen status="Restoring session…" /><AppFeedbackHost /></>, { container: root });
  act(() => setConnectionRecovery('reconnecting'));
  await advance(3000);
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(screen.getByRole('status').textContent).toBe('Reconnecting…');
  expect(document.querySelector('[data-app-feedback]')).toBeNull();
  act(() => setConnectionRecovery('offline'));
  await advance(3000);
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(screen.getByRole('status').textContent).toContain('Offline');
  act(() => setConnectionRecovery('ready'));
  await advance(32);
  expect(screen.getByRole('status').textContent).toBe('Restoring session…');
  view.rerender(<>{null}<AppFeedbackHost /></>);
  await advance(32);
  expect(screen.queryByRole('status')).toBeNull();
});

it('hands an ongoing outage to the toast only after the startup surface is released', async () => {
  const view = render(<><StartupScreen /><AppFeedbackHost /></>, { container: root });
  act(() => setConnectionRecovery('reconnecting'));
  await advance(3000);
  view.rerender(<>{null}<AppFeedbackHost /></>);
  await advance(16);
  expect(surface.hidden).toBe(false);
  expect(document.querySelector('[data-app-feedback]')).toBeNull();
  await advance(16);
  expect(surface.hidden).toBe(true);
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(document.querySelector('[data-app-feedback]')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('status')).toBeNull();
  act(() => setConnectionRecovery('ready'));
  await advance(32);
  act(() => setConnectionRecovery('offline'));
  await advance(2500);
  expect(screen.getByRole('status').textContent).toContain('Offline');
});

it('keeps restore actions and actionable errors available while merging recovery feedback', async () => {
  const inspect = vi.fn(), retry = vi.fn();
  function FailedAction() {
    useAppFeedback({ message: 'Failed action', onAction: retry });
    return null;
  }
  render(<><StartupScreen status="Restoring session…" detail="Saved service" actionLabel="View connection" onAction={inspect} /><AppFeedbackHost /><FailedAction /></>, { container: root });
  act(() => setConnectionRecovery('offline'));
  await advance(3000);
  expect(screen.getAllByRole('status')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'View connection' }));
  expect(inspect).toHaveBeenCalledOnce();
  expect(surface.querySelector('[data-startup-detail]')?.textContent).toBe('Saved service');
  act(() => setConnectionRecovery('ready'));
  await advance(32);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(retry).toHaveBeenCalledOnce();
});
