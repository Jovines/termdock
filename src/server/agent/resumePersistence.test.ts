import { describe, expect, it } from 'vitest';
import {
  canRestoreDeadAgentShell,
  isConfirmedAgentResumeProcess,
  normalizePersistedAgentResumeInfo,
} from './resumePersistence.js';

describe('persisted Agent resume metadata', () => {
  it('keeps a valid native session id and launch argv', () => {
    expect(normalizePersistedAgentResumeInfo({
      slug: 'codex',
      sessionId: '019c1234-abcd-7890',
      launchArgv: ['codex', '--model', 'gpt-5.6'],
      updatedAt: 123.9,
    })).toEqual({
      slug: 'codex',
      sessionId: '019c1234-abcd-7890',
      launchArgv: ['codex', '--model', 'gpt-5.6'],
      updatedAt: 123,
    });
  });

  it('rejects missing or shell-unsafe identity fields', () => {
    expect(normalizePersistedAgentResumeInfo({ slug: 'codex', sessionId: '' })).toBeNull();
    expect(normalizePersistedAgentResumeInfo({ slug: 'codex;evil', sessionId: 'abc' })).toBeNull();
    expect(normalizePersistedAgentResumeInfo({ slug: 'codex', sessionId: 'abc;evil' })).toBeNull();
  });

  it('keeps a dead shell only when both cwd and Agent session id can restore it', () => {
    const agentResume = normalizePersistedAgentResumeInfo({
      slug: 'claude',
      sessionId: 'session-1',
      launchArgv: ['claude'],
      updatedAt: 10,
    });
    expect(canRestoreDeadAgentShell({ cwd: '/repo', agentResume })).toBe(true);
    expect(canRestoreDeadAgentShell({ cwd: null, agentResume })).toBe(false);
    expect(canRestoreDeadAgentShell({ cwd: '/repo', agentResume: null })).toBe(false);
  });

  it('confirms recovery from a matching live resume process', () => {
    const pending = normalizePersistedAgentResumeInfo({
      slug: 'codex',
      sessionId: 'thread-1',
      launchArgv: ['codex'],
      updatedAt: 10,
    });

    expect(isConfirmedAgentResumeProcess(pending, 'codex', 'thread-1')).toBe(true);
    expect(isConfirmedAgentResumeProcess(pending, 'claude', 'thread-1')).toBe(false);
    expect(isConfirmedAgentResumeProcess(pending, 'codex', 'thread-2')).toBe(false);
    expect(isConfirmedAgentResumeProcess(pending, 'codex', null)).toBe(false);
  });
});
