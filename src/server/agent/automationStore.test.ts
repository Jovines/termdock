import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore, nextAutomationRunAt, normalizeAutomationSchedule } from './automationStore.js';

describe('AutomationStore', () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-automations-'));
    filePath = path.join(directory, 'automations.json');
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('validates schedules and calculates the next interval', () => {
    expect(normalizeAutomationSchedule({ kind: 'interval', everyMinutes: 15 })).toEqual({ kind: 'interval', everyMinutes: 15 });
    expect(normalizeAutomationSchedule({ kind: 'interval', everyMinutes: 0 })).toBeNull();
    expect(nextAutomationRunAt({ kind: 'interval', everyMinutes: 5 }, 1_000)).toBe(301_000);
    expect(nextAutomationRunAt({ kind: 'interval', everyMinutes: 5 }, 610_000, 10_000)).toBe(910_000);
  });

  it('keeps interval timing anchored to creation when a task is edited', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const store = new AutomationStore(filePath);
    const task = store.save({
      name: 'Review', enabled: true, cwd: '/repo', command: 'codex', prompt: 'review',
      schedule: { kind: 'interval', everyMinutes: 5 },
    });

    vi.setSystemTime(130_000);
    const edited = store.save({
      id: task.id, name: 'Review updated', enabled: true, cwd: '/repo', command: 'codex', prompt: 'review',
      schedule: { kind: 'interval', everyMinutes: 5 },
    });

    expect(edited.createdAt).toBe(10_000);
    expect(edited.nextRunAt).toBe(310_000);
  });

  it('persists tasks and their run result', () => {
    const store = new AutomationStore(filePath);
    const task = store.save({
      name: 'Review', enabled: true, cwd: '/repo', command: 'codex', prompt: 'review', targetSessionId: null,
      schedule: { kind: 'interval', everyMinutes: 60 },
    });
    const run = store.beginRun(task);
    store.finishRun(run.id, 'success', 'frontend-1', '任务已投递');

    const restored = new AutomationStore(filePath);
    expect(restored.list()[0]).toMatchObject({ id: task.id, name: 'Review', lastRunStatus: 'success' });
    expect(restored.listRuns(task.id)[0]).toMatchObject({ frontendSessionId: 'frontend-1', status: 'success' });
  });

  it('pauses scheduled runs and resumes from the next anchored interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const store = new AutomationStore(filePath);
    const task = store.save({
      name: 'Review', enabled: true, cwd: '/repo', command: 'codex', prompt: 'review',
      schedule: { kind: 'interval', everyMinutes: 5 },
    });

    vi.setSystemTime(310_000);
    expect(store.setEnabled(task.id, false)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(store.due()).toEqual([]);

    vi.setSystemTime(430_000);
    expect(store.setEnabled(task.id, true)).toMatchObject({ enabled: true, nextRunAt: 610_000 });
    expect(new AutomationStore(filePath).get(task.id)).toMatchObject({ enabled: true, nextRunAt: 610_000 });
  });
});
