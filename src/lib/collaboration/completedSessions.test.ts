import { expect, it } from 'vitest';
import type { CollaborationTaskView } from '../terminal/api';
import { completedTaskSessions } from './completedSessions';
const member = { serviceId: 'local', sessionId: 'worker' };
const record = { id: 'task', groupId: 'team', status: 'accepted', activeAttemptId: 'a', attempts: [{ id: 'a', assignee: member }], memberSessions: { 'local:worker': 'worker', 'local:lead': 'lead' }, workspace: { cwd: '/worktree' }, workflow: { kind: 'step', isolated: true, reviewers: [] }, coordinator: { serviceId: 'local', sessionId: 'lead' } } as unknown as CollaborationTaskView;
it('collects only completed isolated execution sessions in the same group', () => {
  expect([...completedTaskSessions([record], 'team')]).toEqual(['worker']);
  expect([...completedTaskSessions([record], 'another')]).toEqual([]);
  expect([...completedTaskSessions([{ ...record, workspace: undefined }], 'team')]).toEqual([]);
  expect([...completedTaskSessions([{ ...record, status: 'open' }], 'team')]).toEqual([]);
});
it('keeps sessions that have another open task or serve as coordinator or reviewer', () => {
  expect([...completedTaskSessions([record, { ...record, id: 'next', status: 'open' }], 'team')]).toEqual([]);
  expect([...completedTaskSessions([{ ...record, coordinator: member }], 'team')]).toEqual([]);
  expect([...completedTaskSessions([{ ...record, workflow: { ...record.workflow!, reviewers: [member] } }], 'team')]).toEqual([]);
});
