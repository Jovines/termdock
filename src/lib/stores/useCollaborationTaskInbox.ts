import { create } from 'zustand';
import { listCollaborationTasks, type CollaborationTaskView } from '../terminal/api';
import { collaborationTaskNeedsAttention } from '../collaboration/taskState';
import { savedConnection } from '../federation/browserIntegration';

function targetKey(): string { return JSON.stringify(savedConnection()); }
function visibleError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  return name === 'UnexpectedEOFError' && /^Unexpected EOF - stream closed while reading \d+\/\d+ bytes$/.test(message)
    || message === 'Secure response ended unexpectedly'
    ? '连接中断，待处理事项暂时无法加载；恢复后会自动重试。'
    : message || '协作待处理事项加载失败';
}

export const useCollaborationTaskInbox = create<{ tasks: CollaborationTaskView[]; allTasks: CollaborationTaskView[]; error: string | null; refresh: () => Promise<void> }>((set) => {
  let nextOwner = 0;
  let displayedTarget: string | undefined;
  let lastLoggedError: string | null = null;
  let active: { owner: number; target: string; controller: AbortController; promise: Promise<void> } | undefined;
  return { tasks: [], allTasks: [], error: null, refresh: async () => {
    const target = targetKey();
    if (active?.target === target) return active.promise;
    active?.controller.abort();
    if(displayedTarget!==target){displayedTarget=target;lastLoggedError=null;set({tasks:[],allTasks:[],error:null});}
    const owner = ++nextOwner, controller = new AbortController();
    const request = { owner, target, controller, promise: Promise.resolve() };
    active = request;
    const isCurrent = () => active?.owner === owner && targetKey() === target;
    request.promise = (async () => {
      try {
        const { tasks } = await listCollaborationTasks(undefined, controller.signal);
        if (isCurrent()) {
          lastLoggedError = null;
          set({ tasks: tasks.filter(collaborationTaskNeedsAttention), allTasks: tasks, error: null });
        }
      } catch (error) {
        if (!isCurrent() || controller.signal.aborted || error instanceof Error && error.name === 'AbortError') return;
        const message = error instanceof Error ? error.message : String(error);
        if (lastLoggedError !== message) { console.error('[CollaborationTaskInbox] refresh failed', error); lastLoggedError = message; }
        set({ error: visibleError(error) });
      } finally {
        if (active?.owner === owner) active = undefined;
      }
    })();
    return request.promise;
  } };
});

export function requestCollaborationTask(groupId: string, taskId: string) {
  try { localStorage.setItem(`termdock:tasks:${location.origin}:${groupId}:open-task`, JSON.stringify(taskId)); } catch { /* Still works in an already open workspace. */ }
  window.dispatchEvent(new CustomEvent('open-collaboration-task', { detail: { groupId, taskId } }));
}
