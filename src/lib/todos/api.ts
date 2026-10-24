import { operationsRequest } from '../terminal/api';
import type { TodoCollector, TodoCreateInput, TodoHandoffInput, TodoItem, TodoLaunchConfig, TodoRun, TodoSnapshot } from '../../server/todos/types';
export type { TodoCollector, TodoItem, TodoLaunchConfig, TodoRun, TodoSnapshot } from '../../server/todos/types';
const post = <T>(path: string, body: unknown) => operationsRequest<T>(`/todos${path}`, { method: 'POST', body: JSON.stringify(body) });
export const listTodos = () => operationsRequest<TodoSnapshot>('/todos');
export const todoCount = () => operationsRequest<{ count: number }>('/todos/summary');
export const createTodo = (input: TodoCreateInput) => post<{ todo: TodoItem }>('', input);
export const updateTodo = (todo: TodoItem, input: { title?: string; description?: string; status?: TodoItem['status'] }) => post<{ todo: TodoItem }>(`/${encodeURIComponent(todo.id)}`, { ...input, revision: todo.revision });
export const saveTodoDefaults = (config: TodoLaunchConfig) => post<{ defaults: TodoLaunchConfig }>('/defaults', config);
export const saveTodoCollector = (input: Partial<TodoCollector> & { name: string; config: TodoLaunchConfig }) => post<{ collector: TodoCollector }>('/collectors', input);
export const removeTodoCollector = (collector: TodoCollector) => post('/collectors/' + encodeURIComponent(collector.id) + '/remove', { revision: collector.revision });
export const startTodo = (id: string, config: TodoLaunchConfig, idempotencyKey: string) => post<{ run: TodoRun }>(`/${encodeURIComponent(id)}/run`, { config, idempotencyKey });
export const handoffTodos = (input: TodoHandoffInput) => post<{ run: TodoRun }>('/handoff', input);
export const collectTodos = (id: string, idempotencyKey: string) => post<{ run: TodoRun }>(`/collectors/${encodeURIComponent(id)}/run`, { idempotencyKey });

export const releaseTodoClaim = (todo: TodoItem) => post<{ todo: TodoItem }>(`/${encodeURIComponent(todo.id)}/release`, { revision: todo.revision });
