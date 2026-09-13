// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectionStatus } from './ConnectionStatus';

vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });
const props = { connectionError: null, isFatalError: false, isRestarting: false, onHardRestart: vi.fn() };

it('avoids flashing on a quick renewal but shows a sustained outage', () => {
  const view = render(<ConnectionStatus {...props} connectionError="Reconnecting..." />);
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByText('connection.reconnecting')).toBeNull();
  view.rerender(<ConnectionStatus {...props} />);
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByText('connection.reconnecting')).toBeNull();
  view.rerender(<ConnectionStatus {...props} connectionError="Reconnecting..." />);
  act(() => vi.advanceTimersByTime(1500));
  expect(screen.getByText('connection.reconnecting')).toBeTruthy();
  view.rerender(<ConnectionStatus {...props} />);
  expect(screen.queryByText('connection.reconnecting')).toBeNull();
});

it('shows fatal errors and retry immediately during the grace period', () => {
  const view = render(<ConnectionStatus {...props} connectionError="Reconnecting..." />);
  view.rerender(<ConnectionStatus {...props} connectionError="Session not found" isFatalError />);
  expect(screen.getByText('Session not found')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'common.retry' })).toBeTruthy();
});
