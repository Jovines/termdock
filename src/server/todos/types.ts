import type { AutomationSchedule } from '../agent/automationStore.js';

export interface TodoLaunchConfig { agentSlug: string; command: string; cwd: string; prompt: string }
export interface TodoRun {
  id: string; kind: 'execute' | 'collect'; todoId: string | null; collectorId: string | null;
  name: string; config: TodoLaunchConfig; createdAt: number; updatedAt: number;
  status: 'launching' | 'delivered' | 'complete' | 'blocked' | 'failed';
  sessionId: string | null; result: string; error: string;
}
export interface TodoItem {
  id: string; title: string; description: string; source: string; sourceUrl: string;
  externalId: string; collectorId: string | null; status: 'open' | 'completed' | 'ignored';
  createdAt: number; updatedAt: number; revision: number;
}
export interface TodoCollector {
  id: string; name: string; enabled: boolean; config: TodoLaunchConfig;
  schedule: AutomationSchedule | null; nextRunAt: number | null; createdAt: number; updatedAt: number; revision: number;
}
export interface TodoSnapshot { todos: TodoItem[]; collectors: TodoCollector[]; runs: TodoRun[]; defaults: TodoLaunchConfig }
export interface TodoCreateInput { title: string; description?: string; source?: string; sourceUrl?: string; externalId?: string; collectorId?: string; idempotencyKey?: string }
