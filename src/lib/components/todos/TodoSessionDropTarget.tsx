import { useState, type ReactNode, type DragEvent } from 'react';
import { getSessionDirectorySnapshot } from '../../stores/useSessionDirectory';
import { savedConnection } from '../../federation/browserIntegration';
import { latestTodoRun, useTodoWorkspace } from '../../todos/workspace';

export const TODO_DRAG_TYPE = 'application/x-termdock-todos';
export const todoWorkspaceKey = () => savedConnection()?.targetPeerId ?? location.origin;
export function startTodoDrag(event: DragEvent, workspace: string, ids: string[]) {
  event.dataTransfer.setData(TODO_DRAG_TYPE, JSON.stringify({ workspace, ids }));
  event.dataTransfer.effectAllowed = 'copy';
}

export function useTodoRecipientSelection() {
  const workspace = todoWorkspaceKey();
  const modal = useTodoWorkspace(state => state.views[workspace]?.modal);
  return modal?.kind === 'recipient' ? { ...modal, workspace } : null;
}

export function chooseTodoRecipient(workspace: string, ids: string[], sessionId: string) {
  const state = useTodoWorkspace.getState(), snapshot = state.snapshots[workspace], modal = state.views[workspace]?.modal;
  if (workspace !== todoWorkspaceKey() || !snapshot || modal && modal.kind !== 'recipient' || !ids.length || ids.length > 50) return false;
  if (!ids.every(id => typeof id === 'string' && snapshot.todos.some(todo => todo.id === id && todo.status === 'open') && latestTodoRun(snapshot, id)?.status !== 'launching')) return false;
  if (sessionId !== '__new__' && !getSessionDirectorySnapshot().some(session => session.sessionId === sessionId && session.agent?.slug)) return false;
  state.patch(workspace, { modal: { kind: 'handoff', ids, sessionId } });
  return true;
}

/** Native todo drags and recipient clicks share the existing sidebar rows. */
export function TodoSessionDropTarget({ sessionId, children, selecting = false, onChosen }: {
  sessionId: string; children: ReactNode; selecting?: boolean; onChosen?: () => void;
}) {
  const [over, setOver] = useState(false);
  const accepts = (event: DragEvent) => event.dataTransfer.types.includes(TODO_DRAG_TYPE)
    && getSessionDirectorySnapshot().some(session => session.sessionId === sessionId && session.agent?.slug);
  return <div className={`flex min-w-0 flex-1 rounded-md ${over ? 'bg-[rgb(var(--primary-rgb)_/_0.15)] ring-1 ring-inset ring-primary' : selecting ? 'hover:bg-[rgb(var(--primary-rgb)_/_0.15)]' : ''}`}
    onClickCapture={event => {
      if (!selecting) return;
      event.preventDefault(); event.stopPropagation();
      const selection = useTodoWorkspace.getState().views[todoWorkspaceKey()]?.modal;
      if (selection?.kind === 'recipient' && chooseTodoRecipient(todoWorkspaceKey(), selection.ids, sessionId)) onChosen?.();
    }}
    onDragOver={event => { if (!accepts(event)) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setOver(true); }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setOver(false); }}
    onDrop={event => {
      setOver(false);
      if (!accepts(event)) return;
      event.preventDefault(); event.stopPropagation();
      try {
        const payload = JSON.parse(event.dataTransfer.getData(TODO_DRAG_TYPE));
        if (!Array.isArray(payload.ids)) return;
        const ids: string[] = [...new Set<string>(payload.ids)];
        if (chooseTodoRecipient(payload.workspace, ids, sessionId)) onChosen?.();
      } catch { /* Ignore foreign or stale drag data. */ }
    }}>{children}</div>;
}
