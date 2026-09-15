import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { progressRoutes } from './progressRoutes.js';
import { parseNotifyCommand } from '../agent/notifyCli.js';

let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); });

it('validates CLI input and allows offline help', () => {
  expect(parseNotifyCommand(['--help']).help).toBe(true);
  expect(parseNotifyCommand(['完成测试', '--session', 'one', '--title', '进展'])).toEqual({ message: '完成测试', session: 'one', title: '进展' });
  for (const args of [ [' '], ['a', 'b'], ['a', '--unknown'], ['a', '--session'], ['x'.repeat(4001)]]) {
    expect(() => parseNotifyCommand(args)).toThrow();
  }
});

it('routes a reminder to the resolved session and fails without a session or connections', async () => {
  const send = vi.fn(() => 2);
  const app = express(); app.use(express.json());
  app.use('/notify', progressRoutes({
    resolveSession: input => input.sessionId === 'one' || (!input.sessionId && input.backendSessionId === 'backend') ? 'one' : null,
    sessionName: id => id === 'one' ? 'Build session' : undefined, send,
  }));
  server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/notify`;
  const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await post({ backendSessionId: 'backend', message: 'Ready for review', title: 'Milestone' });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ ok: true, sessionId: 'one', connections: 2 });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session-notice', sessionId: 'one', sessionName: 'Build session', message: 'Ready for review', title: 'Milestone' }));
  expect((await post({ sessionId: 'missing', backendSessionId: 'backend', message: 'No' })).status).toBe(404);
  expect((await post({ sessionId: 'one', message: ' ' })).status).toBe(400);
  expect((await post({ sessionId: 'one', message: 'OK', title: 7 })).status).toBe(400);
  expect(send).toHaveBeenCalledTimes(1);
  send.mockReturnValue(0);
  const offline = await post({ sessionId: 'one', message: 'Ready' });
  expect(offline.status).toBe(409);
  expect(await offline.json()).toMatchObject({ ok: false, code: 'NO_CONNECTED_CLIENT' });
});
