import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type AutomationSchedule =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; time: string; weekdays: number[] };

export interface AgentAutomation {
  id: string;
  name: string;
  enabled: boolean;
  cwd: string;
  command: string;
  prompt: string;
  targetSessionId: string | null;
  schedule: AutomationSchedule;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunStatus: 'running' | 'success' | 'failed' | null;
  lastRunMessage: string | null;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'success' | 'failed';
  frontendSessionId: string | null;
  message: string | null;
}

interface AutomationDocument {
  version: 1;
  automations: AgentAutomation[];
  runs: AutomationRun[];
}

const MAX_RUNS = 100;

function isTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function normalizeAutomationSchedule(value: unknown): AutomationSchedule | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'interval') {
    const everyMinutes = Number(candidate.everyMinutes);
    if (!Number.isFinite(everyMinutes) || everyMinutes < 1 || everyMinutes > 43_200) return null;
    return { kind: 'interval', everyMinutes: Math.floor(everyMinutes) };
  }
  if (candidate.kind === 'daily' && isTime(candidate.time)) {
    const weekdays = Array.isArray(candidate.weekdays)
      ? Array.from(new Set(candidate.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)))
      : [];
    return { kind: 'daily', time: candidate.time, weekdays: weekdays.length > 0 ? weekdays : [0, 1, 2, 3, 4, 5, 6] };
  }
  return null;
}

export function nextAutomationRunAt(schedule: AutomationSchedule, now = Date.now()): number {
  if (schedule.kind === 'interval') return now + schedule.everyMinutes * 60_000;
  const [hours, minutes] = schedule.time.split(':').map(Number);
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = new Date(candidate);
    date.setDate(candidate.getDate() + offset);
    date.setHours(hours, minutes, 0, 0);
    if (date.getTime() > now && schedule.weekdays.includes(date.getDay())) return date.getTime();
  }
  return now + 24 * 60 * 60_000;
}

export class AutomationStore {
  private document: AutomationDocument = { version: 1, automations: [], runs: [] };

  constructor(private readonly filePath: string) {
    this.load();
  }

  list(): AgentAutomation[] {
    return [...this.document.automations].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listRuns(automationId?: string): AutomationRun[] {
    return this.document.runs
      .filter((run) => !automationId || run.automationId === automationId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): AgentAutomation | null {
    return this.document.automations.find((item) => item.id === id) ?? null;
  }

  save(input: {
    id?: string;
    name: string;
    enabled: boolean;
    cwd: string;
    command: string;
    prompt?: string;
    targetSessionId?: string | null;
    schedule: AutomationSchedule;
  }): AgentAutomation {
    const now = Date.now();
    const existing = input.id ? this.get(input.id) : null;
    const item: AgentAutomation = {
      id: existing?.id ?? crypto.randomUUID(),
      name: input.name.trim(),
      enabled: input.enabled,
      cwd: input.cwd,
      command: input.command.trim(),
      prompt: input.prompt?.trim() ?? '',
      targetSessionId: input.targetSessionId?.trim() || null,
      schedule: input.schedule,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      nextRunAt: input.enabled ? nextAutomationRunAt(input.schedule, now) : null,
      lastRunAt: existing?.lastRunAt ?? null,
      lastRunStatus: existing?.lastRunStatus ?? null,
      lastRunMessage: existing?.lastRunMessage ?? null,
    };
    this.document.automations = existing
      ? this.document.automations.map((candidate) => candidate.id === item.id ? item : candidate)
      : [...this.document.automations, item];
    this.persist();
    return item;
  }

  remove(id: string): boolean {
    const before = this.document.automations.length;
    this.document.automations = this.document.automations.filter((item) => item.id !== id);
    if (before === this.document.automations.length) return false;
    this.persist();
    return true;
  }

  due(now = Date.now()): AgentAutomation[] {
    return this.document.automations.filter((item) => item.enabled && item.nextRunAt !== null && item.nextRunAt <= now);
  }

  beginRun(automation: AgentAutomation): AutomationRun {
    const run: AutomationRun = {
      id: crypto.randomUUID(), automationId: automation.id, startedAt: Date.now(), finishedAt: null,
      status: 'running', frontendSessionId: null, message: null,
    };
    automation.lastRunAt = run.startedAt;
    automation.lastRunStatus = 'running';
    automation.lastRunMessage = null;
    automation.nextRunAt = automation.enabled ? nextAutomationRunAt(automation.schedule, run.startedAt) : null;
    this.document.runs = [run, ...this.document.runs].slice(0, MAX_RUNS);
    this.persist();
    return run;
  }

  finishRun(runId: string, status: 'success' | 'failed', frontendSessionId: string | null, message: string | null): void {
    const run = this.document.runs.find((candidate) => candidate.id === runId);
    if (!run) return;
    run.status = status;
    run.frontendSessionId = frontendSessionId;
    run.message = message;
    run.finishedAt = Date.now();
    const automation = this.get(run.automationId);
    if (automation) {
      automation.lastRunStatus = status;
      automation.lastRunMessage = message;
      automation.updatedAt = Date.now();
    }
    this.persist();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<AutomationDocument>;
      if (!Array.isArray(raw.automations)) return;
      this.document = {
        version: 1,
        automations: raw.automations.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const candidate = item as AgentAutomation;
          const schedule = normalizeAutomationSchedule(candidate.schedule);
          if (!schedule || typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || typeof candidate.command !== 'string') return [];
          return [{ ...candidate, schedule, nextRunAt: candidate.enabled ? nextAutomationRunAt(schedule) : null }];
        }),
        runs: Array.isArray(raw.runs) ? raw.runs.slice(0, MAX_RUNS) as AutomationRun[] : [],
      };
    } catch { /* first run or invalid old file */ }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.document, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }
}
