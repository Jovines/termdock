// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SwipeToCloseSession } from './SwipeToCloseSession';

class TestPointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  constructor(type: string, init: PointerEventInit) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'touch';
    this.isPrimary = init.isPrimary ?? true;
  }
}

beforeEach(() => vi.stubGlobal('PointerEvent', TestPointerEvent));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function setup() {
  const close = vi.fn();
  const select = vi.fn();
  function List() {
    const [openId, setOpenId] = useState<string | null>(null);
    return <>{['One', 'Two'].map(id => (
      <SwipeToCloseSession key={id} open={openId === id}
        onOpenChange={open => setOpenId(current => open ? id : current === id ? null : current)}
        onClose={event => close(id, event)} closeLabel="Close" closeTitle={`Close ${id}`}>
        <button className="sidebar-session-primary" onClick={() => select(id)}>{id}</button>
        <button aria-label={`Split ${id}`}>Split</button>
      </SwipeToCloseSession>
    ))}</>;
  }
  render(<List />);
  return { close, select };
}

function swipe(name: string, dx: number, dy = 0, pointerType = 'touch') {
  const button = screen.getByRole('button', { name });
  fireEvent.pointerDown(button, { clientX: 80, clientY: 100, pointerId: 1, pointerType });
  fireEvent.pointerMove(button, { clientX: 80 + dx, clientY: 100 + dy, pointerId: 1, pointerType });
  fireEvent.pointerUp(button, { clientX: 80 + dx, clientY: 100 + dy, pointerId: 1, pointerType });
  // Browsers can synthesize a click after releasing the pointer.
  fireEvent.click(button);
}

describe('session swipe to close', () => {
  it('reveals on a right swipe without selecting or closing, then uses the close callback', () => {
    const { close, select } = setup();
    swipe('One', 60);
    expect(select).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close One' }));
    expect(close).toHaveBeenCalledWith('One', expect.objectContaining({ type: 'click' }));
    expect(screen.queryByRole('button', { name: 'Close One' })).toBeNull();
  });

  it('snaps a short swipe closed and suppresses its synthesized click', () => {
    const { close, select } = setup();
    swipe('One', 20);
    expect(screen.queryByRole('button', { name: 'Close One' })).toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'One' }));
    expect(select).toHaveBeenCalledWith('One');
  });

  it('leaves vertical scrolling, left swipes and mouse movement alone', () => {
    const { close } = setup();
    swipe('One', 20, 65);
    swipe('One', -65);
    swipe('One', 65, 0, 'mouse');
    expect(screen.queryByRole('button', { name: 'Close One' })).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it('closes the revealed action with a left swipe or a tap on the session', () => {
    const { select } = setup();
    swipe('One', 60);
    swipe('One', -60);
    expect(screen.queryByRole('button', { name: 'Close One' })).toBeNull();
    swipe('One', 60);
    fireEvent.click(screen.getByRole('button', { name: 'One' }));
    expect(screen.queryByRole('button', { name: 'Close One' })).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it('keeps one action open and dismisses it on an outside touch or Escape', () => {
    setup();
    swipe('One', 60);
    swipe('Two', 60);
    expect(screen.queryByRole('button', { name: 'Close One' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close Two' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Two' }), { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Close Two' })).toBeNull();
    swipe('One', 60);
    fireEvent.pointerDown(document.body, { pointerType: 'touch' });
    expect(screen.queryByRole('button', { name: 'Close One' })).toBeNull();
  });

  it('restores the settled position after a cancelled gesture', () => {
    const { close } = setup();
    const button = screen.getByRole('button', { name: 'One' });
    fireEvent.pointerDown(button, { clientX: 80, clientY: 100 });
    fireEvent.pointerMove(button, { clientX: 140, clientY: 100 });
    fireEvent.pointerCancel(button);
    expect(screen.queryByRole('button', { name: 'Close One' })).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it('leaves a held press to drag sorting and ignores gestures starting on action buttons', () => {
    vi.useFakeTimers();
    setup();
    const button = screen.getByRole('button', { name: 'One' });
    fireEvent.pointerDown(button, { clientX: 80, clientY: 100 });
    vi.advanceTimersByTime(125);
    fireEvent.pointerMove(button, { clientX: 140, clientY: 100 });
    fireEvent.pointerUp(button);
    swipe('Split One', 60);
    expect(screen.queryByRole('button', { name: 'Close One' })).toBeNull();
  });
});
