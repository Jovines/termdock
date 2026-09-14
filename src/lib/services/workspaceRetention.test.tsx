// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceWorkspaceHost } from './ServiceWorkspaceHost';
import { consumeWorkspaceSession, installWorkspaceHost } from './workspaceHost';
import { writeBrowserServices, type ServiceConnection } from './serviceDirectory';

const entry: ServiceConnection = { id: 'entry', targetPeerId: 'entry', url: 'https://entry.example', label: 'Entry' };
const services: ServiceConnection[] = Array.from({ length: 10 }, (_, index) => ({
  id: `remote${index}`, targetPeerId: `remote${index}`, url: `https://remote${index}.internal`, label: `Remote ${index}`,
  routes: [{ url: entry.url, targetPeerId: 'entry' }],
}));
const originalTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
const touchPoints = vi.fn(() => 5);

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  delete window.__termdockWorkspaceHost;
  touchPoints.mockReturnValue(5);
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: touchPoints });
  writeBrowserServices([entry, ...services]);
});
afterEach(() => {
  cleanup(); delete window.__termdockWorkspaceHost; vi.restoreAllMocks();
  if (originalTouchPoints) Object.defineProperty(navigator, 'maxTouchPoints', originalTouchPoints);
  else Reflect.deleteProperty(navigator, 'maxTouchPoints');
});

function setup() {
  const host = installWorkspaceHost(entry)!;
  host.report('root', { phase: 'ready', rendered: true });
  render(<ServiceWorkspaceHost><div>Entry terminal</div></ServiceWorkspaceHost>);
  return host;
}
function open(host: ReturnType<typeof setup>, index: number) {
  act(() => { host.activate(services[index]); });
  act(() => { host.report(services[index].id, { phase: 'ready', rendered: true }); });
}

describe('bounded service documents', () => {
  it.each([[5, 3], [0, Infinity]])('applies retention for maxTouchPoints=%s, including the entry', (touch, limit) => {
    touchPoints.mockReturnValue(touch);
    const host = setup();
    for (let index = 0; index < services.length; index++) {
      open(host, index);
      expect(host.snapshot().items.length).toBeLessThanOrEqual(limit);
      expect(document.querySelectorAll('iframe').length).toBeLessThanOrEqual(limit - 1);
      expect(host.snapshot().items.some(item => item.key === 'root')).toBe(true);
      if (!touch) expect(host.snapshot().items).toHaveLength(index + 2);
    }
  });

  it('preserves the painted page through rapid failed switches and cancellation', () => {
    const host = setup();
    open(host, 0);
    const painted = screen.getByTitle('Remote 0');
    act(() => { host.activate(services[1]); });
    act(() => { host.activate(services[2]); host.report('remote2', { phase: 'offline' }); });
    expect(screen.getByTitle('Remote 0')).toBe(painted);
    expect(screen.queryByTitle('Remote 1')).toBeNull();
    expect(painted.style.visibility).toBe('visible');
    fireEvent.click(screen.getByRole('button', { name: '取消切换' }));
    expect(host.snapshot().activeKey).toBe('remote0');
    expect(screen.getByTitle('Remote 0')).toBe(painted);
  });

  it('evicts the least recently used background page and flushes its drafts', () => {
    const host = setup();
    open(host, 0); open(host, 1); open(host, 0);
    const discarded = screen.getByTitle<HTMLIFrameElement>('Remote 1');
    const flush = vi.fn(() => localStorage.setItem('test-workspace-draft', 'unsent text'));
    discarded.contentWindow!.addEventListener('termdock:before-update', flush);
    const backgroundListener = vi.fn();
    host.subscribe(backgroundListener, 'remote1');
    open(host, 2);
    expect(screen.queryByTitle('Remote 1')).toBeNull();
    expect(screen.getByTitle('Remote 0')).toBeTruthy();
    expect(flush).toHaveBeenCalledOnce();
    expect(localStorage.getItem('test-workspace-draft')).toBe('unsent text');
    expect(backgroundListener).not.toHaveBeenCalled();
    act(() => { host.report('remote1', { rendered: true }); });
    expect(host.snapshot().items.some(item => item.key === 'remote1')).toBe(false);
  });

  it('reopens an evicted relay-only service for a notification without stale readiness', () => {
    const host = setup();
    open(host, 0); open(host, 1); open(host, 2);
    expect(screen.queryByTitle('Remote 0')).toBeNull();
    act(() => { expect(host.focusSession('remote0', 'session-from-notification')).toBe(true); });
    const restored = host.snapshot().items.find(item => item.key === 'remote0')!;
    expect(restored.service?.routes).toEqual(services[0].routes);
    expect(restored.rendered).toBeUndefined();
    expect(restored.phase).toBe('connecting');
    expect(consumeWorkspaceSession('remote0')).toBe('session-from-notification');
    expect(screen.getByTitle('Remote 2').style.visibility).toBe('visible');
    act(() => { host.report('remote0', { rendered: true, phase: 'ready' }); });
    expect(screen.getByTitle('Remote 0').style.visibility).toBe('visible');
  });
});
