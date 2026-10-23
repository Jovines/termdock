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
