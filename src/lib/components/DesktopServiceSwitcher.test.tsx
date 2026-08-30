// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopServiceActivity, DesktopServiceActivityBridge } from '../desktop/nativeBridge';
import { DesktopServiceSwitcher } from './DesktopServiceSwitcher';

const labels = {
  switchService: 'Switch service',
  openServices: 'Open services',
  current: 'Current',
  running: 'Running',
  review: 'Needs review',
  idle: 'Idle',
  manageServices: 'Manage services and names',
};

afterEach(cleanup);

function createBridge(services: DesktopServiceActivity[]) {
  const focusService = vi.fn(async () => true);
  const reportServiceActivity = vi.fn();
  const showConnectionCenter = vi.fn(async () => undefined);
  const bridge = {
    focusService,
    reportServiceActivity,
    showConnectionCenter,
    onServiceActivity: (callback: (next: DesktopServiceActivity[]) => void) => {
      callback(services);
      return () => undefined;
    },
  } as unknown as DesktopServiceActivityBridge;
  return { bridge, focusService, reportServiceActivity, showConnectionCenter };
}

describe('DesktopServiceSwitcher', () => {
  it('stays hidden until more than one service window is open', () => {
    const { bridge } = createBridge([
      { origin: 'http://localhost:9834', label: 'Local', current: true, focused: true, runningCount: 0, reviewCount: 0 },
    ]);
    render(<DesktopServiceSwitcher bridge={bridge} runningCount={0} reviewCount={0} labels={labels} />);
    expect(screen.queryByTestId('desktop-service-switcher')).toBeNull();
  });

  it('reports this service and focuses a service selected from the roster', async () => {
    const { bridge, focusService, reportServiceActivity } = createBridge([
      { origin: 'http://localhost:9834', label: 'Local', current: true, focused: true, runningCount: 1, reviewCount: 0 },
      { origin: 'https://studio.example', label: 'Studio Mac', current: false, focused: false, runningCount: 2, reviewCount: 1 },
    ]);
    render(<DesktopServiceSwitcher bridge={bridge} runningCount={1} reviewCount={3} labels={labels} />);

    expect(reportServiceActivity).toHaveBeenCalledWith({ runningCount: 1, reviewCount: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'Switch service' }));
    expect(screen.getByRole('menu', { name: 'Open services' })).toBeTruthy();
    expect(screen.getByText('Studio Mac')).toBeTruthy();

    const studioItem = screen.getByRole('menuitem', { name: /Studio Mac/ });
    expect(within(studioItem).getByTitle('Running').textContent).toContain('2');
    expect(within(studioItem).getByTitle('Needs review').textContent).toContain('1');

    fireEvent.click(studioItem);
    await waitFor(() => expect(focusService).toHaveBeenCalledWith('https://studio.example'));
    expect(screen.queryByRole('menu', { name: 'Open services' })).toBeNull();
  });

  it('prioritizes services needing attention and opens service management', async () => {
    const { bridge, showConnectionCenter } = createBridge([
      { origin: 'https://current.example', label: 'Current', current: true, focused: true, runningCount: 0, reviewCount: 0 },
      { origin: 'https://idle.example', label: 'Idle service', current: false, focused: false, runningCount: 0, reviewCount: 0 },
      { origin: 'https://running.example', label: 'Running service', current: false, focused: false, runningCount: 4, reviewCount: 0 },
      { origin: 'https://review.example', label: 'Review service', current: false, focused: false, runningCount: 0, reviewCount: 2 },
    ]);
    render(<DesktopServiceSwitcher bridge={bridge} runningCount={0} reviewCount={0} labels={labels} />);

    fireEvent.click(screen.getByRole('button', { name: 'Switch service' }));
    const items = screen.getAllByRole('menuitem');
    expect(items[0].textContent).toContain('Current');
    expect(items[1].textContent).toContain('Review service');
    expect(items[2].textContent).toContain('Running service');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Manage services and names' }));
    await waitFor(() => expect(showConnectionCenter).toHaveBeenCalledOnce());
  });
});
