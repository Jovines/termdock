// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppFeedbackHost, useAppFeedback, useFeedbackStore, type Feedback } from './AppFeedback';
import { setConnectionRecovery } from '../../federation/connectionRecovery';

function Notice({ feedback }: { feedback: Feedback | null }) { useAppFeedback(feedback); return null; }
beforeEach(() => { vi.useFakeTimers(); setConnectionRecovery('ready'); useFeedbackStore.setState({ items: [] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('delays brief outages, merges concurrent recovery and clears immediately when recovered', () => {
  const view = render(<><AppFeedbackHost /><Notice feedback={{ tone: 'recovering', message: 'Layout' }} /><Notice feedback={{ tone: 'recovering', message: 'Chat' }} /></>);
  act(() => vi.advanceTimersByTime(2499));
  expect(screen.queryByRole('status')).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(screen.getByRole('status').textContent).toContain('Restoring service updates');
  view.rerender(<><AppFeedbackHost /><Notice feedback={null} /><Notice feedback={null} /></>);
  expect(screen.queryByRole('status')).toBeNull();
});
it('can dismiss a repeating incident without stopping recovery or reappearing on rerender', () => {
  const notice = { tone: 'recovering' as const, message: 'Reconnecting' };
  const view = render(<><AppFeedbackHost /><Notice feedback={notice} /></>);
  act(() => vi.advanceTimersByTime(2500));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  view.rerender(<><AppFeedbackHost /><Notice feedback={{ ...notice }} /></>);
  act(() => vi.advanceTimersByTime(30000));
  expect(screen.queryByRole('status')).toBeNull();
  expect(useFeedbackStore.getState().items).toHaveLength(1);
});
it('offers the actual failed action and expires failures without trapping input', () => {
  const retry = vi.fn();
  render(<><AppFeedbackHost /><Notice feedback={{ message: 'Failed to copy', onAction: retry }} /></>);
  act(() => vi.advanceTimersByTime(0));
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(retry).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => vi.advanceTimersByTime(8000));
  expect(screen.queryByRole('alert')).toBeNull();
});
it('clears the transport notice as soon as the encrypted connection recovers', () => {
  render(<AppFeedbackHost />);
  act(() => setConnectionRecovery('offline'));
  act(() => vi.advanceTimersByTime(2500));
  expect(screen.getByRole('status').textContent).toContain('Offline');
  act(() => setConnectionRecovery('ready'));
  expect(screen.queryByRole('status')).toBeNull();
});
it('dismisses a combined outage as one incident instead of revealing the next duplicate', () => {
  render(<><AppFeedbackHost /><Notice feedback={{ tone: 'recovering', message: 'Layout' }} /><Notice feedback={{ tone: 'recovering', message: 'Chat' }} /></>);
  act(() => vi.advanceTimersByTime(2500));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('status')).toBeNull();
});
