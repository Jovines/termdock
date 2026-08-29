import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentResumeHistoryStore } from './resumeHistory.js';

describe('AgentResumeHistoryStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-agent-resume-history-'));
    file = path.join(dir, 'history.json');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('persists, reloads and deduplicates the same native conversation', () => {
    const store = new AgentResumeHistoryStore(file);
    const first = store.archive({
      title: 'Automatic title',
      titleSource: 'auto',
      agent: { slug: 'codex', sessionId: 'thread-1', launchArgv: ['codex', '--yolo'], updatedAt: 1 },
      cwd: '/repo',
      reason: 'exited',
      closedAt: 10,
    });
    const second = store.archive({
      title: 'Renamed title',
      titleSource: 'custom',
      agent: { slug: 'codex', sessionId: 'thread-1', launchArgv: ['codex'], updatedAt: 2 },
      cwd: '/repo',
      reason: 'closed',
      closedAt: 20,
    });

    expect(second?.id).toBe(first?.id);
    expect(new AgentResumeHistoryStore(file).list()).toMatchObject([{
      title: 'Renamed title',
      titleSource: 'custom',
      reason: 'closed',
      agent: { slug: 'codex', sessionId: 'thread-1' },
    }]);
  });

  it('keeps only the newest configured number of entries and supports removal', () => {
    const store = new AgentResumeHistoryStore(file, 2);
    for (let index = 1; index <= 3; index += 1) {
      store.archive({
        title: `Session ${index}`,
        titleSource: 'default',
        agent: { slug: 'codex', sessionId: `thread-${index}`, launchArgv: null, updatedAt: index },
        cwd: '/repo',
        reason: 'closed',
        closedAt: index,
      });
    }

    expect(store.list().map((entry) => entry.title)).toEqual(['Session 3', 'Session 2']);
    expect(store.remove(store.list()[0]!.id)).toBe(true);
    expect(store.list()).toHaveLength(1);
  });
});
