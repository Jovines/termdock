import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ targets: vi.fn(), connect: vi.fn(), records: new Map<string, any>() }));
vi.mock('./backgroundState', () => ({ backgroundTargets: mocks.targets, backgroundStore: async (action: (store: any) => any) => action({ getAll: () => [...mocks.records.values()], put: (value: any, key: string) => mocks.records.set(key, value), delete: (key: string) => mocks.records.delete(key) }) }));
vi.mock('./backgroundConnection', () => ({ connectBackgroundTarget: mocks.connect }));
import { renewBackgroundSubscriptions, reportBackgroundNotificationClick, flushBackgroundNotificationLogs } from './backgroundNotifications';
const target = { targetPeerId: 'C', addresses: ['https://c.test'], routes: [], preferences: { aiEnabled: true, exitEnabled: false, alertStyle: 'normal', locale: 'zh-CN' } };
beforeEach(() => { vi.clearAllMocks(); mocks.records.clear(); mocks.targets.mockResolvedValue([target]); });
it('renews using current service preferences instead of resurrecting stale browser settings', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ subscription: { aiEnabled: false, exitEnabled: true, alertStyle: 'quiet', locale: 'en' } })).mockResolvedValueOnce(Response.json({ ok: true }));
  const close = vi.fn(); mocks.connect.mockResolvedValue({ fetch, close });
  await renewBackgroundSubscriptions({ endpoint: 'https://push.test/new' });
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ subscription: { endpoint: 'https://push.test/new' }, aiEnabled: false, exitEnabled: true, alertStyle: 'quiet', locale: 'en' });
  expect(close).toHaveBeenCalledOnce();
});
it('does not restore a subscription that the user has explicitly removed', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ subscription: null }));
  mocks.connect.mockResolvedValue({ fetch, close: vi.fn() });
  await renewBackgroundSubscriptions({ endpoint: 'https://push.test/new' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('queues clicks without waiting for network and retries failed delivery without losing records', async () => {
  mocks.connect.mockRejectedValue(new Error('offline'));
  await reportBackgroundNotificationClick('start', 'trace', { targetPeerId: 'C' });
  expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.records.size).toBe(1);
  await flushBackgroundNotificationLogs(); expect(mocks.records.size).toBe(1);
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  mocks.connect.mockResolvedValue({ fetch, close: vi.fn() });
  await flushBackgroundNotificationLogs(); expect(mocks.records.size).toBe(0);
  expect(fetch.mock.calls[0][0]).toBe('/api/client-log');
});
