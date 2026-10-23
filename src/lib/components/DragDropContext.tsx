import { DragDropContext as LibraryDragDropContext, type DragDropContextProps } from '@hello-pangea/dnd';
import { interruptibleDragSensors } from '../hooks/useDragInterruptionSensor';

/** All sortable surfaces inherit the application's interruption contract. */
export function DragDropContext(props: Omit<DragDropContextProps, 'sensors' | 'enableDefaultSensors'>) {
  return <LibraryDragDropContext {...props} sensors={interruptibleDragSensors} />;
}
