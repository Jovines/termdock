import type { TodoItem, TodoRun } from './types.js';
/** One predicate for source availability counts and atomic claim reservation. */
export function canClaimTodo(todo: TodoItem, runs: TodoRun[], now = Date.now()): boolean {
  if (todo.status !== 'open' || todo.autoProcessing?.state === 'pending') return false;
  if (todo.claim) return todo.claim.expiresAt <= now && !runs.find(run => run.id === todo.claim!.runId)?.result;
  return !runs.some(run => run.kind === 'execute' && (run.todoId === todo.id || run.handoff?.todoIds.includes(todo.id)) && run.status !== 'failed');
}
