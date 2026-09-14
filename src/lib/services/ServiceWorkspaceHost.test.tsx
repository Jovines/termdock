// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceWorkspaceHost } from './ServiceWorkspaceHost';
import { installWorkspaceHost, WORKSPACE_ACTIVATE_EVENT } from './workspaceHost';
import { WorkspacePortal } from './WorkspacePortal';
import { AgentFloatingSessionButtons } from '../components/AgentIndicators';
import { useSidebarStore } from '../stores/useSidebarStore';

const entry = { id: 'entry', targetPeerId: 'entry', url: 'https://entry.example', label: 'Entry' };
const remote = { id: 'remote', targetPeerId: 'remote', url: 'https://remote.example', label: 'Remote' };

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  delete window.__termdockWorkspaceHost;
  useSidebarStore.setState({ leftOpen: false, rightOpen: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete window.__termdockWorkspaceHost;
});

function floatingButtons(desktop: boolean) {
  return <AgentFloatingSessionButtons reviewCount={1}
    runningSessions={[{ id: 'running', label: 'Running task' }]}
    activeSessionId="other" runningButtonEnabled isDesktopLayout={desktop}
    containerElement={document.body} />;
}

function boundary(button: HTMLElement) {
  return button.closest<HTMLDivElement>('div[aria-hidden]')!;
}

describe('workspace floating controls', () => {
  it.each([false, true])('anchors loading beside the service strip, desktop=%s', desktop => {
    const host = installWorkspaceHost(entry)!;
    host.report('root', { rendered: true, phase: 'ready' });
    render(<ServiceWorkspaceHost>
      <div data-sidebar-gesture-ignore data-testid="service-strip"><nav aria-label="切换服务" /></div>
    </ServiceWorkspaceHost>);
    const strip = screen.getByTestId('service-strip');
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 340, top: desktop ? 40 : 740, bottom: desktop ? 88 : 788,
      width: 340, height: 48, x: 0, y: desktop ? 40 : 740, toJSON() {},
    });
    act(() => { host.activate(remote); });
    const panel = screen.getByRole('dialog', { name: '切换服务' }).firstElementChild as HTMLElement;
    expect(panel.style.left).toBe('12px');
    expect(panel.style.width).toBe('316px');
    expect(panel.style.top).toBe(desktop ? '96px' : '732px');
    expect(panel.style.transform).toBe(desktop ? 'none' : 'translateY(-100%)');
    fireEvent.click(screen.getByRole('button', { name: '取消切换' }));
    expect(host.snapshot().activeKey).toBe('root');
  });

  it('keeps the first-switch sidebar intent until the destination listener is installed', () => {
    const host = installWorkspaceHost(entry)!;
    host.report('root', { phase: 'ready', rendered: true });
    render(<ServiceWorkspaceHost><button>Entry session</button></ServiceWorkspaceHost>);
    act(() => { host.activate(remote); });
    const frame = screen.getByTitle('Remote') as HTMLIFrameElement;
    const view = frame.contentWindow!;
    // Native load may run before React has installed SecureAccessGate's effect.
    fireEvent.load(frame);
    let activations = 0;
    view.addEventListener(WORKSPACE_ACTIVATE_EVENT, () => { activations++; });
    act(() => { host.attach('remote', view); });
    expect(activations).toBe(1);
    // A repeated registration/load must not reopen a sidebar the user closed.
    fireEvent.load(frame);
    act(() => { host.attach('remote', view); });
    expect(activations).toBe(1);
    expect(frame.style.visibility).toBe('hidden');
    act(() => { host.report('remote', { rendered: true, phase: 'ready' }); });
    expect(frame.style.visibility).toBe('visible');
    expect(screen.queryByRole('dialog', { name: '切换服务' })).toBeNull();
    act(() => { host.activate(entry, false); host.activate(remote); });
    expect(activations).toBe(2);
    expect(frame.style.visibility).toBe('visible');
  });

  it.each([false, true])('keeps background controls hidden and inert, desktop=%s', desktop => {
    const host = installWorkspaceHost(entry)!;
    host.report('root', { phase: 'ready', rendered: true, reviewCount: 1 });
    render(<ServiceWorkspaceHost>{floatingButtons(desktop)}</ServiceWorkspaceHost>);
    const attention = screen.getByRole('button', { name: 'Jump to next session needing attention: 1' });
    const running = screen.getByRole('button', { name: 'Jump to next running session: 1' });
    const root = boundary(attention);
    expect(root).not.toBeNull();
    expect(root.contains(running)).toBe(true);
    expect(root.className).toContain('isolate');

    act(() => { host.activate(remote); });
    // Previous content remains painted during a connection, but its controls
    // belong to the inert workspace, behind the host's switch/cancel dialog.
    expect(root.hasAttribute('inert')).toBe(true);
    expect(screen.getByRole('dialog', { name: '切换服务' })).toBeTruthy();
    act(() => { host.report('remote', { rendered: true, phase: 'ready', reviewCount: 1 }); });
    expect(root.style.visibility).toBe('hidden');
    expect(root.hasAttribute('inert')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Attention across services: 2' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Jump to next running session: 1' })).toBeNull();
    expect(host.snapshot().items.map(item => item.reviewCount)).toEqual([1, 1]);

    act(() => { host.activate(entry, false); });
    expect(root.style.visibility).toBe('visible');
    expect(root.hasAttribute('inert')).toBe(false);
    expect(screen.getByRole('button', { name: 'Attention across services: 2' })).toBe(attention);
    expect(document.querySelectorAll('[data-attention-button]')).toHaveLength(1);
    if (!desktop) {
      act(() => { useSidebarStore.setState({ leftOpen: true }); });
      expect(document.querySelector('[data-attention-button]')).toBeNull();
    }
  });

  it('restores controls when a failed switch is cancelled', () => {
    const host = installWorkspaceHost(entry)!;
    render(<ServiceWorkspaceHost>{floatingButtons(false)}</ServiceWorkspaceHost>);
    const root = boundary(screen.getByRole('button', { name: 'Jump to next session needing attention: 1' }));
    act(() => { host.activate(remote); host.report('remote', { phase: 'offline' }); });
    expect(root.hasAttribute('inert')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '取消切换' }));
    expect(host.snapshot().activeKey).toBe('root');
    expect(root.hasAttribute('inert')).toBe(false);
  });

  it('never exposes entry portals while restoring a remote workspace', () => {
    const host = installWorkspaceHost(entry)!;
    host.activate(remote);
    render(<ServiceWorkspaceHost>{floatingButtons(false)}</ServiceWorkspaceHost>);
    const attention = document.querySelector<HTMLElement>('[data-attention-button]')!;
    expect(boundary(attention).style.visibility).toBe('hidden');
    expect(boundary(attention).hasAttribute('inert')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Jump to next session needing attention: 1' })).toBeNull();
  });

  it('preserves body portals in standalone documents without a workspace host', () => {
    render(<ServiceWorkspaceHost><WorkspacePortal><button>Standalone control</button></WorkspacePortal></ServiceWorkspaceHost>);
    expect(screen.getByRole('button', { name: 'Standalone control' }).parentElement).toBe(document.body);
  });
});
