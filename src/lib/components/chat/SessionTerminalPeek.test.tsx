// @vitest-environment jsdom
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionCapabilitiesContext } from '../../federation/ShareAccessContext';
import { sharedSessionCapabilities } from '../../federation/sessionCapabilities';
import { TerminalPeekContext, TerminalPeekTrigger, terminalPeekPosition, useSessionTerminalPeek } from './SessionTerminalPeek';
const mounted = vi.fn(), unmounted = vi.fn(), expand = vi.fn();
function Terminal() { useEffect(() => { mounted(); return unmounted; }, []); return <textarea aria-label="terminal" defaultValue="retained" />; }
function Harness({ enabled = true }: { enabled?: boolean }) {
  const peek = useSessionTerminalPeek({ enabled, name: '构建检查', expand });
  return <TerminalPeekContext.Provider value={peek.context}>
    <input aria-label="chat" /><div ref={peek.attachNormal} data-normal-slot />
    {createPortal(<Terminal />, peek.host)}
    <TerminalPeekTrigger className="">工作中…</TerminalPeekTrigger>
    <output data-interactive>{String(peek.interactive)}</output>{peek.popover}
  </TerminalPeekContext.Provider>;
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('moves the retained terminal without stealing chat focus or creating another terminal', () => {
  const view = render(<Harness />), chat = screen.getByLabelText('chat'), terminal = screen.getByLabelText('terminal'); chat.focus();
  fireEvent.click(screen.getByRole('button', { name: '查看会话终端' }));
  expect(screen.getByRole('dialog', { name: '会话终端预览' }).contains(terminal)).toBe(true);
  expect(document.activeElement).toBe(chat);
  expect(view.container.querySelector('[data-interactive]')?.textContent).toBe('false');
  fireEvent.pointerDown(terminal);
  expect(view.container.querySelector('[data-interactive]')?.textContent).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: '关闭终端预览' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(view.container.querySelector('[data-normal-slot]')?.contains(terminal)).toBe(true);
  expect(mounted).toHaveBeenCalledOnce(); expect(unmounted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '查看会话终端' }));
  fireEvent.click(screen.getByRole('button', { name: '在完整会话中打开终端' }));
  expect(expand).toHaveBeenCalledOnce(); expect(unmounted).not.toHaveBeenCalled();
});
it('closes when the workspace becomes inactive and never grants shared input from hover', () => {
  const view = render(<SessionCapabilitiesContext.Provider value={sharedSessionCapabilities({ canWrite: false })}><Harness /></SessionCapabilitiesContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: '查看会话终端' }));
  fireEvent.pointerDown(screen.getByLabelText('terminal'));
  expect(view.container.querySelector('[data-interactive]')?.textContent).toBe('false');
  view.rerender(<SessionCapabilitiesContext.Provider value={sharedSessionCapabilities({ canWrite: false })}><Harness enabled={false} /></SessionCapabilitiesContext.Provider>);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: '查看会话终端' })).toBeNull();
});
it('does not offer a preview without an authenticated session view capability', () => {
  render(<SessionCapabilitiesContext.Provider value={new Set()}><Harness /></SessionCapabilitiesContext.Provider>);
  expect(screen.queryByRole('button', { name: '查看会话终端' })).toBeNull();
});
it.each([{ x: 32, y: 650, width: 180, height: 36 }, { x: 1100, y: 40, width: 160, height: 36 }])('keeps the bubble within the viewport beside its trigger: $y', rect => {
  const result = terminalPeekPosition(new DOMRect(rect.x, rect.y, rect.width, rect.height), 1280, 900);
  expect(result.left).toBeGreaterThanOrEqual(12); expect(result.top).toBeGreaterThanOrEqual(12);
  expect(result.left + result.width).toBeLessThanOrEqual(1268);
  expect(result.top + result.height).toBeLessThanOrEqual(888);
});
