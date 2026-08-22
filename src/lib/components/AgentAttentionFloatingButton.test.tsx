// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  window.localStorage.clear();
  useSidebarStore.setState({ leftOpen: false, rightOpen: false });
});

afterEach(() => {
  cleanup();
  useSidebarStore.setState({ leftOpen: false, rightOpen: false });
});

describe('AgentFloatingSessionButtons', () => {
  it('starts on the lower-right side of the terminal area', () => {
    const terminalArea = createTerminalArea();
    const bounds = terminalArea.getBoundingClientRect();
    render(
      <AgentFloatingSessionButtons
        reviewCount={2}
        runningCount={0}
        runningButtonEnabled={false}
        canJumpToRunningSession={false}
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

  it('stays available beside desktop sidebars but hides behind mobile drawers', () => {
    const terminalArea = createTerminalArea();
    useSidebarStore.setState({ leftOpen: true });
    const { rerender } = render(
      <AgentFloatingSessionButtons
        reviewCount={1}
        runningCount={0}
        runningButtonEnabled={false}
        canJumpToRunningSession={false}
        isDesktopLayout
        containerElement={terminalArea}
      />,
    );

    expect(screen.getByRole('button', { name: 'Jump to next session needing attention: 1' })).toBeTruthy();

    rerender(
      <AgentFloatingSessionButtons
        reviewCount={1}
        runningCount={0}
        runningButtonEnabled={false}
        canJumpToRunningSession={false}
        isDesktopLayout={false}
        containerElement={terminalArea}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Jump to next session needing attention: 1' })).toBeNull();
  });

  it('keeps the running button separate and lets it drag independently', () => {
    const terminalArea = createTerminalArea();
    const bounds = terminalArea.getBoundingClientRect();
    render(
      <AgentFloatingSessionButtons
        reviewCount={2}
        runningCount={3}
        runningButtonEnabled
        canJumpToRunningSession
        isDesktopLayout
        containerElement={terminalArea}
      />,
    );

    const attention = screen.getByRole('button', { name: 'Jump to next session needing attention: 2' });
    const running = screen.getByRole('button', { name: 'Jump to next running session: 3' });
    const deltaX = Math.abs(Number.parseFloat(attention.style.left) - Number.parseFloat(running.style.left));
    const deltaY = Math.abs(Number.parseFloat(attention.style.top) - Number.parseFloat(running.style.top));
    expect(deltaX >= MOBILE_ATTENTION_SIZE_PX || deltaY >= MOBILE_ATTENTION_SIZE_PX).toBe(true);

    Object.defineProperty(running, 'setPointerCapture', { value: vi.fn() });
    const startX = Number.parseFloat(running.style.left);
    const startY = Number.parseFloat(running.style.top);
    fireEvent.pointerDown(running, { pointerId: 7, clientX: startX, clientY: startY });
    fireEvent.pointerMove(running, { pointerId: 7, clientX: bounds.left, clientY: startY });
    fireEvent.pointerUp(running, { pointerId: 7, clientX: bounds.left, clientY: startY });

    expect(Number.parseFloat(running.style.left)).toBe(bounds.left + MOBILE_ATTENTION_EDGE_GAP_PX);
  });

  it('hides the running button when the only running session is already active', () => {
    const terminalArea = createTerminalArea();
    const { rerender } = render(
      <AgentFloatingSessionButtons
        reviewCount={0}
        runningCount={1}
        runningButtonEnabled
        canJumpToRunningSession={false}
        isDesktopLayout
        containerElement={terminalArea}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Jump to next running session: 1' })).toBeNull();

    rerender(
      <AgentFloatingSessionButtons
        reviewCount={0}
        runningCount={1}
        runningButtonEnabled
        canJumpToRunningSession
        isDesktopLayout
        containerElement={terminalArea}
      />,
    );
    expect(screen.getByRole('button', { name: 'Jump to next running session: 1' })).toBeTruthy();
  });
});
