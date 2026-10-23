import { expect, it, vi } from 'vitest';
import { executeTodoCommand, parseTodoCommand } from './cli.js';
it.each([['add'], ['report', 'run', '--status', 'complete'], ['add', '--title', 'x', '--source'], ['list', '--title', 'x'], ['add', '--title', 'x', '--description', 'one', '--stdin'], ['report', 'run', '--status', 'unknown', '--content', 'x']].map(args => ({ args })))('rejects incomplete or ambiguous arguments $args', ({ args }) => { expect(() => parseTodoCommand(args)).toThrow(); });
it('forwards source and deduplication identity without creating an execution', async () => {
  const io = { request: vi.fn(async () => ({ statusCode: 200, body: '{"todo":{"id":"created"}}' })), stdin: vi.fn(async () => '详细背景'), write: vi.fn() };
  expect(await executeTodoCommand(parseTodoCommand(['add', '--title', '巡检待办', '--source', '项目', '--external-id', 'stable', '--stdin']), io)).toBe(0);
  expect(io.request).toHaveBeenCalledExactlyOnceWith('POST', '/api/terminal/operations/todos', expect.objectContaining({ title: '巡检待办', description: '详细背景', externalId: 'stable', source: '项目' }));
});
it('targets a specific run for reporting and never retries an uncertain write', async () => {
  const io = { request: vi.fn().mockRejectedValue(new Error('connection closed')), stdin: vi.fn(), write: vi.fn() };
  expect(await executeTodoCommand(parseTodoCommand(['report', 'run/id', '--status', 'blocked', '--content', '需要补充资料']), io)).toBe(1);
  expect(io.request).toHaveBeenCalledExactlyOnceWith('POST', '/api/terminal/operations/todos/runs/run%2Fid/report', { status: 'blocked', content: '需要补充资料' });
});
it('shows help without a running service', async () => { const io = { request: vi.fn(), stdin: vi.fn(), write: vi.fn() }; expect(await executeTodoCommand(parseTodoCommand(['--help']), io)).toBe(0); expect(io.request).not.toHaveBeenCalled(); });
