import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionSearchStore } from './sessionSearchStore.js';

describe('SessionSearchStore', () => {
  let directory: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termdock-session-search-')); });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('indexes terminal output and restores metadata after restart', () => {
    const store = new SessionSearchStore(directory);
    store.append({
      sessionId: 'session-1', backendSessionId: 'backend-1', title: 'Release', cwd: '/repo',
      agentSlug: 'codex', agentNativeSessionId: 'native-1', updatedAt: 1,
    }, '\u001b[31mImplement searchable session recovery\u001b[0m\n');
    store.flush();

    const restored = new SessionSearchStore(directory);
    expect(restored.search('searchable')).toMatchObject([{
      sessionId: 'session-1', title: 'Release', agentNativeSessionId: 'native-1', matchCount: 1,
    }]);
  });

  it('searches title and cwd even before output exists', () => {
    const store = new SessionSearchStore(directory);
    store.update({
      sessionId: 'session-2', backendSessionId: null, title: 'Database migration', cwd: '/work/api',
      agentSlug: null, agentNativeSessionId: null, updatedAt: 1,
    });
    expect(store.search('migration')[0]?.sessionId).toBe('session-2');
  });
});
