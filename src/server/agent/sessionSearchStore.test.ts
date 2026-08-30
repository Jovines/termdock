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

  it('rotates capped output instead of rewriting the full log on each append', () => {
    const store = new SessionSearchStore(directory);
    const metadata = {
      sessionId: 'session-3', backendSessionId: 'backend-3', title: 'Long session', cwd: '/repo',
      agentSlug: 'codex', agentNativeSessionId: 'native-3', updatedAt: 1,
    };
    const logPath = path.join(directory, 'session-3.log');
    const oldOutput = `${'a'.repeat(1024 * 1024 - 16)}old-search-term\n`;
    fs.writeFileSync(logPath, oldOutput);

    store.append(metadata, 'new-search-term\n');
    store.flush();

    expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toBe(oldOutput);
    expect(fs.readFileSync(logPath, 'utf8')).toBe('new-search-term\n');
    expect(store.search('old-search-term')[0]?.sessionId).toBe('session-3');
    expect(store.search('new-search-term')[0]?.sessionId).toBe('session-3');
  });

  it('removes old sessions and orphaned logs during budget maintenance', () => {
    fs.writeFileSync(path.join(directory, 'sessions.json'), JSON.stringify({ version: 1, sessions: [
      { sessionId: 'old', backendSessionId: null, title: 'Old', cwd: '/old', agentSlug: null, agentNativeSessionId: null, updatedAt: 1 },
      { sessionId: 'new', backendSessionId: null, title: 'New', cwd: '/new', agentSlug: null, agentNativeSessionId: null, updatedAt: 2 },
    ] }));
    fs.writeFileSync(path.join(directory, 'old.log'), 'old output');
    fs.writeFileSync(path.join(directory, 'new.log'), 'new output');
    fs.writeFileSync(path.join(directory, 'orphan.log'), 'orphan output');

    const store = new SessionSearchStore(directory, { maxSessions: 1, maxAgeMs: Number.MAX_SAFE_INTEGER });

    expect(store.search('new output')[0]?.sessionId).toBe('new');
    expect(store.search('old output')).toEqual([]);
    expect(fs.existsSync(path.join(directory, 'old.log'))).toBe(false);
    expect(fs.existsSync(path.join(directory, 'orphan.log'))).toBe(false);
  });

  it('drops rotated segments before current output when the global budget is exceeded', () => {
    fs.writeFileSync(path.join(directory, 'sessions.json'), JSON.stringify({ version: 1, sessions: [
      { sessionId: 'session', backendSessionId: null, title: 'Session', cwd: '/repo', agentSlug: null, agentNativeSessionId: null, updatedAt: Date.now() },
    ] }));
    fs.writeFileSync(path.join(directory, 'session.log.1'), 'previous-output');
    fs.writeFileSync(path.join(directory, 'session.log'), 'current-output');

    new SessionSearchStore(directory, {
      maxTotalBytes: Buffer.byteLength('current-output'),
      maxAgeMs: Number.MAX_SAFE_INTEGER,
    });

    expect(fs.existsSync(path.join(directory, 'session.log.1'))).toBe(false);
    expect(fs.readFileSync(path.join(directory, 'session.log'), 'utf8')).toBe('current-output');
  });

  it('does not rewrite metadata for every output flush when identity is unchanged', () => {
    const metadata = {
      sessionId: 'session', backendSessionId: 'backend', title: 'Session', cwd: '/repo',
      agentSlug: 'codex', agentNativeSessionId: 'native', updatedAt: Date.now(),
    };
    const metadataPath = path.join(directory, 'sessions.json');
    fs.writeFileSync(metadataPath, JSON.stringify({ version: 1, sessions: [metadata] }));
    const before = fs.readFileSync(metadataPath, 'utf8');
    const store = new SessionSearchStore(directory);

    store.append(metadata, 'fresh output');
    store.flush();

    expect(fs.readFileSync(metadataPath, 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(directory, 'session.log'), 'utf8')).toBe('fresh output');
  });
});
