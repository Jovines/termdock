import fs from 'node:fs';
import path from 'node:path';
import { normalizePersistedAgentResumeInfo, type PersistedAgentResumeInfo } from './resumePersistence.js';
import type { CollaborationTask, TaskWorkspace } from './collaborationTaskTypes.js';

export interface ExecutionArchive {
  sessionId: string; title: string; agent: PersistedAgentResumeInfo; cwd: string;
  groups: Array<{ id: string; role?: string }>; taskIds: string[]; workspace: TaskWorkspace;
  archivedAt: number; restoredAt?: number;
  cleanup: { state: 'pending' | 'removed' | 'retained'; reason?: string; commit?: string };
}

/** Explicit archives are durable records, independent of the recent-history cap. */
export class ExecutionArchiveStore {
  private entries: ExecutionArchive[];
  constructor(private file: string) {
    try {
      const document = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (document.version !== 1 || !Array.isArray(document.entries)) throw new Error('执行归档文件格式无效');
      this.entries = document.entries.map((entry: ExecutionArchive) => {
        const agent = normalizePersistedAgentResumeInfo(entry.agent);
        if (!agent || !entry.sessionId || !entry.workspace?.cwd || !Array.isArray(entry.groups) || !Array.isArray(entry.taskIds)) throw new Error('执行归档记录无效');
        return { ...entry, agent };
      });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.entries = []; }
  }
  list(): ExecutionArchive[] { return structuredClone(this.entries); }
  get(id: string): ExecutionArchive | undefined { return this.list().find(entry => entry.sessionId === id); }
  save(entry: ExecutionArchive): ExecutionArchive {
    if (!normalizePersistedAgentResumeInfo(entry.agent)) throw new Error('没有可恢复的 Agent 原生会话 ID，终端已保留');
    const entries = [structuredClone(entry), ...this.entries.filter(item => item.sessionId !== entry.sessionId)];
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
    fs.renameSync(temporary, this.file); this.entries = entries;
    return structuredClone(entry);
  }
}

export function completedExecution(tasks: CollaborationTask[], serviceId: string, sessionId: string): CollaborationTask[] {
  const matches = (member: { serviceId: string; sessionId: string } | null | undefined) => member?.serviceId === serviceId && member.sessionId === sessionId;
  if (tasks.some(task => matches(task.coordinator) || task.workflow?.reviewers.some(matches)
    || task.status === 'open' && (matches(task.attempts.find(a => a.id === task.activeAttemptId)?.assignee) || matches(task.scheduledAssignee)))) {
    throw new Error('此会话仍承担协作工作，不能归档；请完成当前任务后再操作');
  }
  const completed = tasks.filter(task => task.status !== 'open' && task.workspace && task.workflow?.kind === 'step' && task.workflow.isolated
    && matches(task.attempts.find(a => a.id === task.activeAttemptId)?.assignee));
  if (!completed.length) throw new Error('此会话没有已完成的独立执行任务，终端已保留');
  return completed;
}
