import { create } from 'zustand';
import { listCollaborationTasks, type CollaborationTaskView } from '../terminal/api';
import { collaborationTaskNeedsAttention } from '../collaboration/taskState';

export const useCollaborationTaskInbox = create<{ tasks: CollaborationTaskView[]; error: string | null; refresh: () => Promise<void> }>((set) => {
  let running = false;
  return { tasks: [], error: null, refresh: async () => {
    if (running) return; running = true;
    try { const { tasks } = await listCollaborationTasks(); set({ tasks: tasks.filter(collaborationTaskNeedsAttention), error: null }); }
    catch (error) { set({ error: error instanceof Error ? error.message : '协作待处理事项加载失败' }); }
    finally { running = false; }
  } };
});

export function requestCollaborationTask(groupId: string, taskId: string) {
  try { localStorage.setItem(`termdock:tasks:${location.origin}:${groupId}:open-task`, JSON.stringify(taskId)); } catch { /* Still works in an already open workspace. */ }
  window.dispatchEvent(new CustomEvent('open-collaboration-task', { detail: { groupId, taskId } }));
}
