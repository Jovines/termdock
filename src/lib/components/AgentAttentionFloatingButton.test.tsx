// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AgentFloatingSessionButtons } from './AgentIndicators';
import { useSidebarStore } from '../stores/useSidebarStore';
import {
  MOBILE_ATTENTION_EDGE_GAP_PX,
  MOBILE_ATTENTION_SIZE_PX,
} from '../utils/mobileAttentionPosition';

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}
if (!window.PointerEvent) {
  window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
}

function createTerminalArea({
  left = 0,
  top = 40,
  right = window.innerWidth - 240,
  bottom = window.innerHeight,
} = {}): HTMLElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => ({
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect),
  });
  return element;
}

beforeEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  useSidebarStore.setState({ leftOpen: false, rightOpen: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useSidebarStore.setState({ leftOpen: false, rightOpen: false });
});

describe('AgentFloatingSessionButtons', () => {
  it('starts on the lower-right side of the terminal area', () => {
    const terminalArea = createTerminalArea();
    const bounds = terminalArea.getBoundingClientRect();
    render(
      <AgentFloatingSessionButtons
        reviewCount={2}
        runningSessions={[]}
        activeSessionId={null}
        runningButtonEnabled={false}
        isDesktopLayout
        containerElement={terminalArea}
      />,
    );

    const button = screen.getByRole('button', { name: 'Jump to next session needing attention: 2' });
    expect(Number.parseFloat(button.style.left)).toBe(
      bounds.right - MOBILE_ATTENTION_EDGE_GAP_PX - MOBILE_ATTENTION_SIZE_PX,
    );
    const minY = Math.max(bounds.top + 12, 52);
    const maxY = bounds.bottom - MOBILE_ATTENTION_EDGE_GAP_PX - MOBILE_ATTENTION_SIZE_PX;
    expect(Number.parseFloat(button.style.top)).toBeCloseTo(
      minY + ((maxY - minY) * 0.68),
    );
    expect(Number.parseFloat(button.style.left) + MOBILE_ATTENTION_SIZE_PX)
      .toBeLessThan(bounds.right);
    expect(button.className).toContain('inline-flex');
    expect(button.className).not.toContain('max-lg:inline-flex');
  });

  it('keeps both floating controls left of a pinned right sidebar inset', () => {
    const terminalArea = createTerminalArea({ right: window.innerWidth });
    const rightInset = 240;
    render(
      <AgentFloatingSessionButtons
        reviewCount={2}
        runningSessions={[
          { id: 'first', label: 'First workspace' },
          { id: 'second', label: 'Second workspace' },
        ]}
        activeSessionId="other"
        runningButtonEnabled
        isDesktopLayout
        containerElement={terminalArea}
        occlusionInsets={{ right: rightInset }}
      />,
    );

    const terminalContentRight = window.innerWidth - rightInset;
    const attention = screen.getByRole('button', { name: 'Jump to next session needing attention: 2' });
    const running = screen.getByRole('button', { name: 'Jump to next running session: 2' });
    expect(Number.parseFloat(attention.style.left) + MOBILE_ATTENTION_SIZE_PX)
      .toBeLessThanOrEqual(terminalContentRight - MOBILE_ATTENTION_EDGE_GAP_PX);
    expect(Number.parseFloat(running.style.left) + MOBILE_ATTENTION_SIZE_PX)
      .toBeLessThanOrEqual(terminalContentRight - MOBILE_ATTENTION_EDGE_GAP_PX);
  });

  it('stays available beside desktop sidebars but hides behind mobile drawers', () => {
    const terminalArea = createTerminalArea();
    useSidebarStore.setState({ leftOpen: true });
    const { rerender } = render(
      <AgentFloatingSessionButtons
        reviewCount={1}
        runningSessions={[]}
        activeSessionId={null}
        runningButtonEnabled={false}
        isDesktopLayout
        containerElement={terminalArea}
      />,
    );

    expect(screen.getByRole('button', { name: 'Jump to next session needing attention: 1' })).toBeTruthy();

    rerender(
      <AgentFloatingSessionButtons
        reviewCount={1}
        runningSessions={[]}
        activeSessionId={null}
        runningButtonEnabled={false}
        isDesktopLayout={false}
        containerElement={terminalArea}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Jump to next session needing attention: 1' })).toBeNull();
  });

  it('keeps the running control separate and visually unchanged at rest', () => {
    const terminalArea = createTerminalArea();
    render(
      <AgentFloatingSessionButtons
        reviewCount={2}
        runningSessions={[
          { id: 'first', label: 'First workspace' },
          { id: 'second', label: 'Second workspace' },
          { id: 'third', label: 'Third workspace' },
        ]}
        activeSessionId="second"
        runningButtonEnabled
        isDesktopLayout
        containerElement={terminalArea}
      />,
    );

    const attention = screen.getByRole('button', { name: 'Jump to next session needing attention: 2' });
    const running = screen.getByRole('button', { name: 'Jump to next running session: 3' });
    expect(Number.parseFloat(running.style.width)).toBe(MOBILE_ATTENTION_SIZE_PX);
    expect(Number.parseFloat(running.style.height)).toBe(MOBILE_ATTENTION_SIZE_PX);
    expect(running.querySelector('.animate-spin')).toBeTruthy();
    expect(screen.queryByRole('listbox', { name: 'Select a running session' })).toBeNull();
    const deltaX = Math.abs(Number.parseFloat(attention.style.left) - Number.parseFloat(running.style.left));
    const deltaY = Math.abs(Number.parseFloat(attention.style.top) - Number.parseFloat(running.style.top));
    expect(deltaX >= MOBILE_ATTENTION_SIZE_PX || deltaY >= MOBILE_ATTENTION_SIZE_PX).toBe(true);
  });

  it('hides the running button when the only running session is already active', () => {
    const terminalArea = createTerminalArea();
    const { rerender } = render(
      <AgentFloatingSessionButtons
        reviewCount={0}
        runningSessions={[{ id: 'running', label: 'Running workspace' }]}
        activeSessionId="running"
        runningButtonEnabled
        isDesktopLayout
        containerElement={terminalArea}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Jump to next running session: 1' })).toBeNull();

    rerender(
      <AgentFloatingSessionButtons
        reviewCount={0}
        runningSessions={[{ id: 'running', label: 'Running workspace' }]}
        activeSessionId="other"
        runningButtonEnabled
        isDesktopLayout
        containerElement={terminalArea}
      />,
    );
    expect(screen.getByRole('button', { name: 'Jump to next running session: 1' })).toBeTruthy();
  });

  it('cycles to the next running session on a tap', () => {
    const onSwitch = vi.fn();
    window.addEventListener('switch-terminal-session', onSwitch);
    render(
      <AgentFloatingSessionButtons
        reviewCount={0}
        runningSessions={[
          { id: 'first', label: 'First workspace' },
          { id: 'second', label: 'Second workspace' },
          { id: 'third', label: 'Third workspace' },
        ]}
        activeSessionId="second"
        runningButtonEnabled
        isDesktopLayout
        containerElement={createTerminalArea()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Jump to next running session: 3' }));

    expect((onSwitch.mock.calls[0]?.[0] as CustomEvent<string>).detail).toBe('third');
    window.removeEventListener('switch-terminal-session', onSwitch);
  });

  it('reveals the inward rail on a horizontal swipe and selects where the pointer lands', () => {
    const onSwitch = vi.fn();
    window.addEventListener('switch-terminal-session', onSwitch);
    render(
      <AgentFloatingSessionButtons
        reviewCount={0}
        runningSessions={[
          { id: 'first', label: 'First workspace' },
          { id: 'second', label: 'Second workspace' },
          { id: 'third', label: 'Third workspace' },
        ]}
        activeSessionId="first"
        runningButtonEnabled
        isDesktopLayout
        containerElement={createTerminalArea()}
      />,
    );

    const button = screen.getByRole('button', { name: 'Jump to next running session: 3' });
    Object.defineProperty(button, 'setPointerCapture', { value: vi.fn() });
    const startX = Number.parseFloat(button.style.left) + (MOBILE_ATTENTION_SIZE_PX / 2);
    const startY = Number.parseFloat(button.style.top) + (MOBILE_ATTENTION_SIZE_PX / 2);
    fireEvent.pointerDown(button, { pointerId: 8, clientX: startX, clientY: startY });
    fireEvent.pointerMove(button, { pointerId: 8, clientX: startX - 12, clientY: startY });

    const rail = screen.getByRole('listbox', { name: 'Select a running session' });
    expect(rail.getAttribute('data-side')).toBe('left');
    const railLeft = Number.parseFloat(rail.style.left);
    const railTop = Number.parseFloat(rail.style.top);
    const railWidth = Number.parseFloat(rail.style.width);
    const targetX = railLeft + ((railWidth / 3) * 2.5);
    const targetY = railTop + 26;
    fireEvent.pointerMove(button, { pointerId: 8, clientX: targetX, clientY: targetY });
    expect(document.querySelector('[data-running-session-option="third"]')?.getAttribute('data-selected'))
      .toBe('true');
    fireEvent.pointerUp(button, { pointerId: 8, clientX: targetX, clientY: targetY });

    expect((onSwitch.mock.calls[0]?.[0] as CustomEvent<string>).detail).toBe('third');
    expect(screen.queryByRole('listbox', { name: 'Select a running session' })).toBeNull();
    window.removeEventListener('switch-terminal-session', onSwitch);
  });

  it('keeps the swipe rail on the correct side inside a narrow offset terminal', () => {
    const terminalArea = createTerminalArea({ left: 520, right: 820 });
    render(
      <AgentFloatingSessionButtons
        reviewCount={0}
        runningSessions={[
          { id: 'first', label: 'First workspace' },
          { id: 'second', label: 'Second workspace' },
          { id: 'third', label: 'Third workspace' },
        ]}
        activeSessionId="first"
        runningButtonEnabled
        isDesktopLayout
        containerElement={terminalArea}
      />,
    );

    const button = screen.getByRole('button', { name: 'Jump to next running session: 3' });
    Object.defineProperty(button, 'setPointerCapture', { value: vi.fn() });
    const buttonLeft = Number.parseFloat(button.style.left);
    const startX = buttonLeft + (MOBILE_ATTENTION_SIZE_PX / 2);
    const startY = Number.parseFloat(button.style.top) + (MOBILE_ATTENTION_SIZE_PX / 2);
    fireEvent.pointerDown(button, { pointerId: 10, clientX: startX, clientY: startY });
    fireEvent.pointerMove(button, { pointerId: 10, clientX: startX - 12, clientY: startY });

    const rail = screen.getByRole('listbox', { name: 'Select a running session' });
    const railLeft = Number.parseFloat(rail.style.left);
    const railRight = railLeft + Number.parseFloat(rail.style.width);
    expect(rail.getAttribute('data-side')).toBe('left');
    expect(railLeft).toBeGreaterThanOrEqual(520 + MOBILE_ATTENTION_EDGE_GAP_PX);
    expect(railRight).toBeLessThanOrEqual(buttonLeft - 10);
  });

  it('only drags after a long press, then snaps within the terminal', () => {
    vi.useFakeTimers();
    const terminalArea = createTerminalArea();
    const bounds = terminalArea.getBoundingClientRect();
    render(
      <AgentFloatingSessionButtons
        reviewCount={0}
        runningSessions={[
          { id: 'first', label: 'First workspace' },
          { id: 'second', label: 'Second workspace' },
        ]}
        activeSessionId="first"
        runningButtonEnabled
        isDesktopLayout
        containerElement={terminalArea}
      />,
    );

    const button = screen.getByRole('button', { name: 'Jump to next running session: 2' });
    Object.defineProperty(button, 'setPointerCapture', { value: vi.fn() });
    const startX = Number.parseFloat(button.style.left);
    const startY = Number.parseFloat(button.style.top);
    fireEvent.pointerDown(button, { pointerId: 9, clientX: startX, clientY: startY });
    act(() => vi.advanceTimersByTime(380));
    expect(button.getAttribute('data-running-session-gesture')).toBe('dragging');
    fireEvent.pointerMove(button, { pointerId: 9, clientX: bounds.left, clientY: startY });
    fireEvent.pointerUp(button, { pointerId: 9, clientX: bounds.left, clientY: startY });

    expect(Number.parseFloat(button.style.left)).toBe(bounds.left + MOBILE_ATTENTION_EDGE_GAP_PX);
    act(() => vi.runOnlyPendingTimers());
  });
});
