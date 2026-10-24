import type { AutomationSchedule } from '../agent/automationStore.js';

export interface TodoLaunchConfig { agentSlug: string; command: string; cwd: string; prompt: string }
export interface TodoSessionPolicy { mode: 'new' | 'reuse'; targetSessionId: string | null; beforePrompt: string; idleMinutes: number }
export interface TodoProcessing { mode: 'manual' | 'new' | 'existing'; sessionId: string | null; config: TodoLaunchConfig | null; note: string }
export interface TodoClaim { id: string; sessionId: string; sessionName: string; claimedAt: number; expiresAt: number; runId: string }
export interface TodoRun {
  id: string; kind: 'execute' | 'collect'; todoId: string | null; collectorId: string | null;
  name: string; config: TodoLaunchConfig; createdAt: number; updatedAt: number;
  status: 'launching' | 'delivered' | 'complete' | 'blocked' | 'failed';
  sessionId: string | null; result: string; error: string;
  collectionSession?: TodoSessionPolicy & { owned: boolean; runtimeIdentity?: string; recycledAt?: number };
  handoff?: { todoIds: string[]; note: string; targetSessionId: string | null; sessionName: string };
}
export interface TodoHandoffInput { todoIds: string[]; sessionId?: string; config?: TodoLaunchConfig; note: string; idempotencyKey: string }
export interface TodoItem {
  id: string; title: string; description: string; source: string; sourceUrl: string;
  claim?: TodoClaim | null;
  autoProcessing?: { policy: TodoProcessing; state: 'pending' | 'dispatched' | 'failed'; runId: string | null; error: string };
  externalId: string; collectorId: string | null; status: 'open' | 'completed' | 'ignored';
  createdAt: number; updatedAt: number; revision: number;
}
export interface TodoCollector {
  id: string; name: string; enabled: boolean; config: TodoLaunchConfig;
  processing?: TodoProcessing;
  webhook?: { enabled: boolean; secret: string };
  session?: TodoSessionPolicy;
  schedule: AutomationSchedule | null; nextRunAt: number | null; createdAt: number; updatedAt: number; revision: number;
}
export interface TodoSnapshot { todos: TodoItem[]; collectors: TodoCollector[]; runs: TodoRun[]; defaults: TodoLaunchConfig }
export interface TodoCreateInput { title: string; description?: string; source?: string; sourceUrl?: string; externalId?: string; collectorId?: string; idempotencyKey?: string }
