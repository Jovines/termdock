import { describe, expect, it } from 'vitest';
import type { CollaborationTaskView } from '../terminal/api';
import { collaborationBoardStatus, collaborationBoardTasks } from './boardTasks';

export const boardTask = (id: string, overrides: Partial<CollaborationTaskView> = {}): CollaborationTaskView => ({
  id, ownerServiceId: 'local', groupId: 'team', title: id, spec: '交付说明', constraints: '', acceptance: '',
  createdAt: 1, updatedAt: 2, revision: 1, coordinator: null, parentTaskId: null, dependsOn: [], status: 'open',
  activeAttemptId: null, attempts: [], events: [], decisions: [], artifacts: [], deliveries: [], outbox: [], memberSessions: {}, ...overrides,
});
describe('goal-focused collaboration board', () => {
  it('keeps a goal and standalone work visible while nesting all execution descendants', () => {
    const root = boardTask('goal'), child = boardTask('child', { parentTaskId: root.id });
    const nested = boardTask('nested', { parentTaskId: child.id }), standalone = boardTask('standalone');
    const rows = collaborationBoardTasks([root, child, nested, standalone]);
    expect(rows.map(row => row.task.id)).toEqual(['goal', 'standalone']);
    expect(rows[0].children.map(task => task.id)).toEqual(['child', 'nested']);
    expect(collaborationBoardTasks([root, child], true)).toHaveLength(2);
    expect(collaborationBoardTasks([root, child], false, 'child')).toHaveLength(2);
  });
  it('surfaces a hidden member question before other child exceptions', () => {
    const root = boardTask('goal');
    const blocked = boardTask('blocked', { parentTaskId: root.id, automationIssue: '投递异常' });
    const question = boardTask('question', { parentTaskId: root.id, decisions: [{ id: 'q', attemptId: 'a', question: '请选择范围', options: [], status: 'pending', createdAt: 2 }] });
    expect(collaborationBoardTasks([root, blocked, question])[0].attention?.id).toBe('question');
    expect(collaborationBoardStatus(question)).toBe('请回答成员的问题');
    expect(collaborationBoardTasks([root, blocked])[0].attention?.id).toBe('blocked');
  });
  it('preserves the goal’s own decision and does not imply an accepted goal needs action', () => {
    const child = boardTask('child', { parentTaskId: 'goal', automationIssue: '异常' });
    expect(collaborationBoardTasks([boardTask('goal', { automationIssue: '目标异常' }), child])[0].attention).toBeUndefined();
    expect(collaborationBoardTasks([boardTask('goal', { status: 'accepted' }), child])[0].attention).toBeUndefined();
    expect(collaborationBoardStatus(boardTask('goal', { status: 'accepted' }))).toBe('已完成 · 你已验收');
    expect(collaborationBoardStatus(boardTask('child', { status: 'accepted', completionMode: 'reviewed' }))).toBe('执行交付已评审');
  });
  it('retains orphaned work, active work under a closed goal and malformed cyclic records', () => {
    const orphan = boardTask('orphan', { parentTaskId: 'missing' });
    const closed = boardTask('closed', { status: 'closed' }), active = boardTask('active', { parentTaskId: closed.id });
    const a = boardTask('a', { parentTaskId: 'b' }), b = boardTask('b', { parentTaskId: 'a' });
    const rows = collaborationBoardTasks([orphan, closed, active, b, a]);
    expect(rows.map(row => row.task.id)).toEqual(['orphan', 'closed', 'active', 'a']);
    expect(rows.at(-1)?.children.map(task => task.id)).toEqual(['b']);
  });
  it('reports completed execution separately from the overall goal', () => {
    expect(collaborationBoardStatus(boardTask('goal'), [boardTask('child', { status: 'accepted' })])).toBe('执行交付已评审 · 等待总结果');
    expect(collaborationBoardStatus(boardTask('goal'), [boardTask('child')])).toBe('目标未完成 · 执行交付待齐');
  });
});
