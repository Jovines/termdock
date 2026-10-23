import type { TodoLaunchConfig, TodoSnapshot } from './api';

type Choice = Omit<TodoLaunchConfig, 'prompt'>;
interface Preferences { choice?: Choice; directories: string[] }
const storageKey = (service: string) => `termdock:todo-preferences:v1:${service}`;
export const directoryName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;
export function uniqueDirectories(paths: Array<string | null | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => typeof path === 'string' && !!path.trim()).map(path => path.trim().replace(/\/+$/, '') || '/'))];
}
export function readTodoPreferences(service: string): Preferences {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(service)) || '{}');
    const choice = raw?.choice;
    return { choice: choice && ['agentSlug', 'command', 'cwd'].every(key => typeof choice[key] === 'string') ? choice : undefined,
      directories: uniqueDirectories(Array.isArray(raw?.directories) ? raw.directories : []).slice(0, 8) };
  } catch { return { directories: [] }; }
}
/** Keep successful choices, never half-typed paths or the task's instructions. */
export function rememberTodoChoice(service: string, config: TodoLaunchConfig) {
  try {
    const previous = readTodoPreferences(service);
    localStorage.setItem(storageKey(service), JSON.stringify({ choice: { agentSlug: config.agentSlug, command: config.command, cwd: config.cwd }, directories: uniqueDirectories([config.cwd, ...previous.directories]).slice(0, 8) }));
  } catch { /* Server defaults and saved collectors still work without browser storage. */ }
}
export function todoDirectoryChoices(current: string, recent: string[], data: TodoSnapshot | null, service: string): string[] {
  return uniqueDirectories([current, ...readTodoPreferences(service).directories, data?.defaults.cwd,
    ...(data?.runs.slice().reverse().map(run => run.config.cwd) ?? []), ...recent,
    ...(data?.collectors.map(collector => collector.config.cwd) ?? [])]).slice(0, 8);
}
