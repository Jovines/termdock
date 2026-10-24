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

const collectorArgs = ['collector', 'create', '--name', '社区渠道', '--agent', 'codex', '--prompt', '筛选可执行事项，附上来源，避免重复，只收集不执行'];
it.each([
  ['collector'], ['collector', 'list', '--disabled'], ['collector', 'create', '--name', '渠道'],
  [...collectorArgs, '--stdin'], [...collectorArgs, '--every', '0'], [...collectorArgs, '--every', '1.5'],
  [...collectorArgs, '--every', '43201'], [...collectorArgs, '--at', '24:00'],
  [...collectorArgs, '--weekdays', '1'], [...collectorArgs, '--at', '09:00', '--weekdays', '7'],
  [...collectorArgs, '--at', '09:00', '--every', '60'], [...collectorArgs, 'unexpected'],
].map(args => ({ args })))('rejects ambiguous collector configuration $args', ({ args }) => { expect(() => parseTodoCommand(args)).toThrow(); });

it('discovers Agents and lists directions through read-only service requests', async () => {
  const io = { request: vi.fn().mockResolvedValueOnce({ statusCode: 200, body: '{"agents":[{"slug":"codex","command":"codex"}]}' }).mockResolvedValueOnce({ statusCode: 200, body: '{"todos":[],"collectors":[{"id":"channel"}]}' }), stdin: vi.fn(), write: vi.fn() };
  expect(await executeTodoCommand(parseTodoCommand(['agents']), io)).toBe(0);
  expect(await executeTodoCommand(parseTodoCommand(['collector', 'list']), io)).toBe(0);
  expect(io.request.mock.calls).toEqual([['GET', '/api/terminal/agent-launchers'], ['GET', '/api/terminal/operations/todos', undefined]]);
  expect(JSON.parse(io.write.mock.calls[1][0])).toEqual({ collectors: [{ id: 'channel' }] });
});

it('creates a scheduled direction using the detected launch command without launching an Agent', async () => {
  const io = { request: vi.fn().mockResolvedValueOnce({ statusCode: 200, body: '{"agents":[{"slug":"codex","command":"codex --profile collector"}]}' }).mockResolvedValueOnce({ statusCode: 200, body: '{"collector":{"id":"created"}}' }), stdin: vi.fn(), write: vi.fn() };
  expect(await executeTodoCommand(parseTodoCommand([...collectorArgs, '--cwd', '/tmp', '--at', '09:00', '--weekdays', '1,2,3,4,5']), io)).toBe(0);
  expect(io.request).toHaveBeenLastCalledWith('POST', '/api/terminal/operations/todos/collectors', {
    name: '社区渠道', config: { agentSlug: 'codex', command: 'codex --profile collector', cwd: '/tmp', prompt: collectorArgs.at(-1) },
    enabled: true, schedule: { kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] },
  });
  expect(io.request).toHaveBeenCalledTimes(2);
});

it('accepts stdin and an explicit command, defaults to manual, and supports disabled intervals', async () => {
  const io = { request: vi.fn(async () => ({ statusCode: 200, body: '{"collector":{"id":"saved"}}' })), stdin: vi.fn(async () => '从当前讨论的渠道收集，保留链接'), write: vi.fn() };
  const args = ['collector', 'create', '--name', '渠道', '--agent', 'codex', '--command', 'codex --profile work', '--stdin'];
  expect(await executeTodoCommand(parseTodoCommand(args), io)).toBe(0);
  expect(io.request).toHaveBeenLastCalledWith('POST', '/api/terminal/operations/todos/collectors', expect.objectContaining({ schedule: null, enabled: true, config: { agentSlug: 'codex', command: 'codex --profile work', cwd: process.cwd(), prompt: '从当前讨论的渠道收集，保留链接' } }));
  expect(await executeTodoCommand(parseTodoCommand([...args, '--every', '120', '--disabled']), io)).toBe(0);
  expect(io.request).toHaveBeenLastCalledWith('POST', '/api/terminal/operations/todos/collectors', expect.objectContaining({ schedule: { kind: 'interval', everyMinutes: 120 }, enabled: false }));
});

it('rejects empty collection requirements and unavailable Agents without writing or retrying', async () => {
  const io = { request: vi.fn(async () => ({ statusCode: 200, body: '{"agents":[]}' })), stdin: vi.fn(async () => '  '), write: vi.fn() };
  expect(await executeTodoCommand(parseTodoCommand(['collector', 'create', '--name', '渠道', '--agent', 'codex', '--stdin']), io)).toBe(1);
  expect(io.request).not.toHaveBeenCalled();
  expect(await executeTodoCommand(parseTodoCommand(collectorArgs), io)).toBe(1);
  expect(io.request).toHaveBeenCalledTimes(1);
  io.request.mockRejectedValueOnce(new Error('connection closed'));
  expect(await executeTodoCommand(parseTodoCommand([...collectorArgs, '--command', 'codex']), io)).toBe(1);
  expect(io.request).toHaveBeenCalledTimes(2);
});
