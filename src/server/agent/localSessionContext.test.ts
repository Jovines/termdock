import { expect, it, vi } from 'vitest';
import { detectLocalSessionContext, resolveLocalCollaborationContext } from './localSessionContext.js';
import { parseCollaborationCommand, executeCollaborationCommand } from './collaborationCli.js';

it('uses stable explicit identity without probing a detached process or mixing stale hints', async () => {
  const detect = vi.fn(async () => ({ backendSessionId: 'wrong', tmuxSessionName: 'wrong' }));
  expect(await resolveLocalCollaborationContext('mine', { TERMDOCK_COLLAB_SESSION_ID: 'other' }, detect)).toEqual({ sessionId: 'mine' });
  expect(await resolveLocalCollaborationContext(undefined, { TERMDOCK_COLLAB_SESSION_ID: 'mine' }, detect)).toEqual({ sessionId: 'mine' });
  expect(detect).not.toHaveBeenCalled();
});

it('does not guess a default tmux session when all identity variables are missing', async () => {
  const run = vi.fn(async () => 'someone-else');
  expect(await detectLocalSessionContext({}, run)).toEqual({ backendSessionId: null, tmuxSessionName: null });
  expect(await detectLocalSessionContext({ TMUX: 'socket' }, run)).toEqual({ backendSessionId: null, tmuxSessionName: null });
  expect(run).not.toHaveBeenCalled();
});

it('accepts a pane hint without TMUX and preserves a backend identity on tmux failure', async () => {
  const run = vi.fn(async () => 'original-tmux\n');
  expect(await detectLocalSessionContext({ TMUX_PANE: '%173', TERMDOCK_BACKEND_SESSION_ID: 'stale' }, run))
    .toEqual({ backendSessionId: 'stale', tmuxSessionName: 'original-tmux' });
  expect(run).toHaveBeenCalledWith('tmux', ['display-message', '-p', '-t', '%173', '#S']);
  expect(await detectLocalSessionContext({ TMUX_PANE: '%173', TERMDOCK_BACKEND_SESSION_ID: 'live' }, async () => { throw new Error('offline'); }))
    .toEqual({ backendSessionId: 'live', tmuxSessionName: null });
});

it.each([
  ['status'], ['inbox'], ['send', 'recipient', 'hello'], ['reply', 'message-id', 'ack'],
  ['rebind', '--pane', '%173'], ['message', 'read', 'message-id'],
])('passes explicit sender independently of targets and pane: %j', async (...args) => {
  const command = parseCollaborationCommand([...args, '--session', 'sender']);
  const context = await resolveLocalCollaborationContext(command.options.session as string, {});
  const request = vi.fn(async () => ({ statusCode: 200, body: '{"ok":true}' }));
  await executeCollaborationCommand(command, context, { request, write: () => {} });
  const [method, endpoint, body] = request.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
  if (method === 'GET') expect(new URL(endpoint, 'http://localhost').searchParams.get('sessionId')).toBe('sender');
  else expect(body.sessionId).toBe('sender');
  if (args[0] === 'rebind') expect(body.pane).toBe('%173');
});

it('rejects empty identity and keeps literal message text intact', () => {
  expect(() => parseCollaborationCommand(['status', '--session', ' '])).toThrow(/non-empty/);
  expect(() => parseCollaborationCommand(['status', '--session'])).toThrow(/requires/);
  expect(parseCollaborationCommand(['send', 'peer', '--', '--session hello']).message).toBe('--session hello');
});
