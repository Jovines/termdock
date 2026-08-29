import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutomationStore, nextAutomationRunAt, normalizeAutomationSchedule } from './automationStore.js';

describe('AutomationStore', () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-automations-'));
    filePath = path.join(directory, 'automations.json');
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('validates schedules and calculates the next interval', () => {
    expect(normalizeAutomationSchedule({ kind: 'interval', everyMinutes: 15 })).toEqual({ kind: 'interval', everyMinutes: 15 });
    expect(normalizeAutomationSchedule({ kind: 'interval', everyMinutes: 0 })).toBeNull();
    expect(nextAutomationRunAt({ kind: 'interval', everyMinutes: 5 }, 1_000)).toBe(301_000);
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
});
