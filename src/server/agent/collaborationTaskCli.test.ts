import { expect, it, vi } from 'vitest';
import { parseCollaborationCommand } from './collaborationCli.js';
import { executeTaskCommand } from './collaborationTaskCli.js';

it('accepts the documented coordination summary and preserves full content and revision', async () => {
  const request = vi.fn(async () => ({}));
  const command = parseCollaborationCommand(['--session', 'coordinator', 'task', 'coordinate', 'goal',
    '--revision', '7', '--summary', '两项交付已评审，等待汇总。', '--content', '完整安排与证据', '--idempotency-key', 'coordinate-v7']);
  await executeTaskCommand(command, request, { request: vi.fn(), write: vi.fn() });
  expect(request).toHaveBeenCalledWith('POST', '/tasks/goal', { input: expect.objectContaining({
    kind: 'coordinate', expectedRevision: 7, summary: '两项交付已评审，等待汇总。',
    content: '完整安排与证据', idempotencyKey: 'coordinate-v7',
  }) });
});
