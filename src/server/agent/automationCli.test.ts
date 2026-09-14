import { describe, expect, it, vi } from 'vitest';
import { executeAutomationCommand, parseAutomationCommand, type AutomationCliIO } from './automationCli.js';

describe('automation CLI', () => {
  it.each([
    ['create', '--name', 'test', '--every', '0', '--self', '--prompt', 'test'],
    ['create', '--name', 'test', '--every', '1.5', '--self', '--prompt', 'test'],
    ['create', '--name', 'test', '--at', '24:00', '--command', 'test'],
    ['create', '--name', 'test', '--at', '09:00', '--weekdays', '7', '--command', 'test'],
    ['create', '--name', 'test', '--every', '5', '--prompt', 'test'],
    ['create', '--name', 'test', '--every', '5', '--self', '--session', 'a', '--prompt', 'test'],
    ['create', '--name', 'test', '--every', '5', '--self', '--prompt', 'test', '--stdin'],
    ['delete'], ['list', '--disabled'], ['pause', 'id', 'extra'],
  ])('rejects invalid arguments %j', (...args) => {
    expect(() => parseAutomationCommand(args)).toThrow();
  });
  const makeIO = (): AutomationCliIO => ({
    request: vi.fn().mockResolvedValue({ statusCode: 200, body: '{"automation":{"id":"new"}}' }),
    self: vi.fn().mockResolvedValue('resolved-session'), stdin: vi.fn().mockResolvedValue('多行\n任务'), write: vi.fn(),
  });
  it('resolves self and preserves multiline stdin without executing it', async () => {
    const io = makeIO();
    expect(await executeAutomationCommand(parseAutomationCommand(['create', '--name', 'review', '--every', '30', '--self', '--stdin']), io)).toBe(0);
    expect(io.request).toHaveBeenCalledWith('POST', '/api/terminal/operations/automations', {
      name: 'review', schedule: { kind: 'interval', everyMinutes: 30 }, enabled: true,
      command: '', prompt: '多行\n任务', targetSessionId: 'resolved-session',
    });
  });
  it('creates a disabled daily new-session task in the caller directory', async () => {
    const io = makeIO();
    await executeAutomationCommand(parseAutomationCommand(['create', '--name', 'review', '--at', '09:00', '--weekdays', '1,2,1', '--command', 'agent --flag', '--disabled']), io);
    expect(io.request).toHaveBeenCalledWith('POST', expect.any(String), expect.objectContaining({
      schedule: { kind: 'daily', time: '09:00', weekdays: [1, 2] }, enabled: false, cwd: process.cwd(), targetSessionId: null,
    }));
    expect(io.self).not.toHaveBeenCalled();
  });
  it('does not create a task when self resolution fails', async () => {
    const io = makeIO(); vi.mocked(io.self).mockRejectedValue(new Error('stale session'));
    expect(await executeAutomationCommand(parseAutomationCommand(['create', '--name', 'test', '--every', '5', '--self', '--prompt', 'test']), io)).toBe(1);
    expect(io.request).not.toHaveBeenCalled();
  });
  it.each(['pause', 'resume', 'run', 'delete'])('routes %s and accepts no-content deletion', async (action) => {
    const io = makeIO(); vi.mocked(io.request).mockResolvedValue({ statusCode: 204, body: '' });
    expect(await executeAutomationCommand(parseAutomationCommand([action, 'a/b']), io)).toBe(0);
    expect(io.request).toHaveBeenCalledWith(action === 'delete' ? 'DELETE' : 'POST', `/api/terminal/operations/automations/a%2Fb${action === 'delete' ? '' : action === 'run' ? '/run' : '/enabled'}`, action === 'delete' ? undefined : action === 'run' ? {} : { enabled: action === 'resume' });
  });
  it.each([{ statusCode: 404, body: '{"error":"missing"}' }, { statusCode: 200, body: 'not-json' }])('returns nonzero on invalid service responses', async response => {
    const io = makeIO(); vi.mocked(io.request).mockResolvedValue(response);
    expect(await executeAutomationCommand(parseAutomationCommand(['list']), io)).toBe(1);
  });
  it('does not retry failed requests', async () => {
    const io = makeIO(); vi.mocked(io.request).mockRejectedValue(new Error('connection closed'));
    expect(await executeAutomationCommand(parseAutomationCommand(['run', 'id']), io)).toBe(1);
    expect(io.request).toHaveBeenCalledTimes(1);
  });
  it('prints help without service access', async () => {
    const io = makeIO();
    expect(await executeAutomationCommand(parseAutomationCommand(['--help']), io)).toBe(0);
    expect(io.request).not.toHaveBeenCalled();
  });
});
