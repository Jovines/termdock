// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DragDropContext, Draggable, Droppable, type SensorAPI } from '@hello-pangea/dnd';
import { interruptActiveDrag, interruptibleDragSensors, useDragInterruptionSensor } from './useDragInterruptionSensor';
import { useSuperLongPress } from './useSuperLongPress';

class TouchPointer extends MouseEvent {
  pointerId = 1;
  pointerType = 'touch';
}
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('PointerEvent', TouchPointer); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function Press({ onFire, onClick = () => {} }: { onFire: () => void; onClick?: () => void }) {
  const bind = useSuperLongPress();
  return <button {...bind(onFire)} onClick={onClick}>Hold</button>;
}

it('cancels an actual active DnD drag with CANCEL before opening a long-press menu', () => {
  const end = vi.fn(), fire = vi.fn(() => expect(end).toHaveBeenCalledWith(expect.objectContaining({ reason: 'CANCEL' }), expect.anything()));
  render(<><Press onFire={fire} /><DragDropContext sensors={interruptibleDragSensors} onDragEnd={end}>
    <Droppable droppableId="list">{drop => <div ref={drop.innerRef} {...drop.droppableProps}>
      <Draggable draggableId="one" index={0}>{drag => <div ref={drag.innerRef} {...drag.draggableProps} {...drag.dragHandleProps}>Drag</div>}</Draggable>
      {drop.placeholder}
    </div>}</Droppable>
  </DragDropContext></>);
  const draggable = screen.getByText('Drag');
  draggable.focus();
  fireEvent.keyDown(draggable, { key: ' ', code: 'Space', keyCode: 32 });
  act(() => vi.advanceTimersByTime(30));
  expect(draggable.style.position).toBe('fixed');
  fireEvent.pointerDown(screen.getByText('Hold'), { clientX: 50, clientY: 50 });
  act(() => vi.advanceTimersByTime(550));
  expect(fire).toHaveBeenCalledOnce();
  expect(draggable.style.position).not.toBe('fixed');
  fireEvent.keyDown(draggable, { key: 'ArrowDown', keyCode: 40 });
  expect(end).toHaveBeenCalledOnce();
});

it('releases pending sensor locks and unregisters when the context unmounts', () => {
  const release = vi.fn();
  const api = { tryReleaseLock: release } as unknown as SensorAPI;
  function Sensor() { useDragInterruptionSensor(api); return null; }
  const view = render(<Sensor />);
  interruptActiveDrag(); expect(release).toHaveBeenCalledOnce();
  view.unmount(); interruptActiveDrag(); expect(release).toHaveBeenCalledOnce();
});

function setupDrag() {
  const end = vi.fn();
  const view = render(<DragDropContext sensors={interruptibleDragSensors} onDragEnd={end}>
    <Droppable droppableId="list">{drop => <div ref={drop.innerRef} {...drop.droppableProps}>
      <Draggable draggableId="one" index={0}>{drag => <div ref={drag.innerRef} {...drag.draggableProps} {...drag.dragHandleProps}>Drag</div>}</Draggable>
      {drop.placeholder}
    </div>}</Droppable>
  </DragDropContext>);
  const draggable = screen.getByText('Drag');
  const mouseDown = () => fireEvent.mouseDown(draggable, { button: 0, buttons: 1, clientX: 10, clientY: 10 });
  const mouseMove = () => {
    fireEvent.mouseMove(window, { buttons: 1, clientX: 10, clientY: 30 });
    act(() => vi.advanceTimersByTime(30));
  };
  return { ...view, end, draggable, mouseDown, mouseMove };
}

it.each(['mousemove', 'pointermove'])('cancels a drag on %s without the held left button after a lost mouseup', (type) => {
  const { draggable, mouseDown, mouseMove, end } = setupDrag();
  mouseDown(); mouseMove();
  expect(draggable.style.position).toBe('fixed');
  if (type === 'mousemove') {
    fireEvent.mouseMove(window, { buttons: 0, clientX: 10, clientY: 50 });
  } else {
    // The suite's PointerEvent shim normally represents a touch pointer.
    const event = new MouseEvent('pointermove', { buttons: 0, clientX: 10, clientY: 50 });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    fireEvent(window, event);
  }
  expect(draggable.style.position).not.toBe('fixed');
  expect(end).toHaveBeenCalledOnce();
  expect(end).toHaveBeenCalledWith(expect.objectContaining({ reason: 'CANCEL' }), expect.anything());
  // A fresh press works immediately without an extra click to clear the lock.
  mouseDown(); mouseMove();
  expect(draggable.style.position).toBe('fixed');
  fireEvent.mouseUp(window);
  act(() => vi.runAllTimers());
  expect(end).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'DROP' }), expect.anything());
});

it('releases a pending mouse lift before unpressed movement can start a ghost drag', () => {
  const { draggable, mouseDown, mouseMove, end } = setupDrag();
  mouseDown();
  fireEvent.mouseMove(window, { buttons: 0, clientX: 10, clientY: 50 });
  act(() => vi.advanceTimersByTime(30));
  expect(draggable.style.position).not.toBe('fixed');
  expect(end).not.toHaveBeenCalled();
  mouseDown(); mouseMove();
  expect(draggable.style.position).toBe('fixed');
});

it.each([false, true])('releases mouse gestures when the window loses focus (lifted=%s)', (lifted) => {
  const { draggable, mouseDown, mouseMove, end } = setupDrag();
  mouseDown();
  if (lifted) mouseMove();
  fireEvent.blur(window);
  mouseMove();
  expect(draggable.style.position).not.toBe('fixed');
  expect(end).toHaveBeenCalledTimes(lifted ? 1 : 0);
  if (lifted) expect(end).toHaveBeenCalledWith(expect.objectContaining({ reason: 'CANCEL' }), expect.anything());
});

it('preserves keyboard dragging when the mouse moves with no button held', () => {
  const { draggable, end } = setupDrag();
  fireEvent.mouseDown(draggable, { button: 0, buttons: 1 });
  fireEvent.mouseUp(window);
  draggable.focus();
  fireEvent.keyDown(draggable, { key: ' ', code: 'Space', keyCode: 32 });
  act(() => vi.advanceTimersByTime(30));
  fireEvent.mouseMove(window, { buttons: 0 });
  const event = new MouseEvent('pointermove', { buttons: 0 });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  fireEvent(window, event);
  expect(draggable.style.position).toBe('fixed');
  expect(end).not.toHaveBeenCalled();
  fireEvent.keyDown(draggable, { key: 'Escape', keyCode: 27 });
  expect(end).toHaveBeenCalledWith(expect.objectContaining({ reason: 'CANCEL' }), expect.anything());
});

it('preserves a touch drag when touch pointer movement reports no mouse buttons', () => {
  const { draggable, end } = setupDrag();
  const touch = { identifier: 1, clientX: 10, clientY: 10, target: draggable };
  fireEvent.touchStart(draggable, { touches: [touch] });
  act(() => vi.advanceTimersByTime(180));
  fireEvent.pointerMove(window, { buttons: 0, clientX: 10, clientY: 30 });
  fireEvent.mouseMove(window, { buttons: 0 });
  expect(draggable.style.position).toBe('fixed');
  expect(end).not.toHaveBeenCalled();
  fireEvent.touchEnd(window, { touches: [], changedTouches: [touch] });
  act(() => vi.runAllTimers());
  expect(end).toHaveBeenCalledWith(expect.objectContaining({ reason: 'DROP' }), expect.anything());
});

it('keeps intentional movement as dragging, cleans timers on unmount or blur, and suppresses the release click', () => {
  const fire = vi.fn(), click = vi.fn();
  const view = render(<Press onFire={fire} onClick={click} />);
  const button = screen.getByText('Hold');
  fireEvent.pointerDown(button, { clientX: 10, clientY: 10 });
  fireEvent.pointerMove(button, { clientX: 10, clientY: 30 });
  act(() => vi.advanceTimersByTime(550));
  expect(fire).not.toHaveBeenCalled();
  fireEvent.pointerDown(button); fireEvent.blur(window);
  act(() => vi.advanceTimersByTime(550)); expect(fire).not.toHaveBeenCalled();
  fireEvent.pointerDown(button); act(() => vi.advanceTimersByTime(550));
  fireEvent.pointerUp(button); fireEvent.click(button);
  expect(fire).toHaveBeenCalledOnce(); expect(click).not.toHaveBeenCalled();
  fireEvent.click(button); expect(click).toHaveBeenCalledOnce();
  fireEvent.pointerDown(button); act(() => vi.advanceTimersByTime(550));
  fireEvent.pointerUp(button);
  // No compatibility click arrived; the next deliberate tap still works.
  fireEvent.pointerDown(button); fireEvent.pointerUp(button); fireEvent.click(button);
  expect(click).toHaveBeenCalledTimes(2);
  fireEvent.pointerDown(button); view.unmount(); act(() => vi.advanceTimersByTime(550));
  expect(fire).toHaveBeenCalledTimes(2);
});
