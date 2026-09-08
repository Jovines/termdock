import { backgroundStore, backgroundTargets, type BackgroundTarget } from './backgroundState';
import { connectBackgroundTarget } from './backgroundConnection';
export async function renewBackgroundSubscriptions(subscription: PushSubscriptionJSON): Promise<void> {
  const targets = await backgroundTargets();
  const results = await Promise.allSettled(targets.map(async target => {
    const client = await connectBackgroundTarget(target);
    try {
      // Read preferences from the service so a closed tab cannot restore stale toggles.
      const status = await client.fetch('/api/notifications/status');
      if (!status.ok) throw new Error('Push status unavailable');
      const current = await status.json();
      if (!current.subscription) return; // An explicit unsubscribe must stay revoked.
      const response = await client.fetch('/api/notifications/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription, ...target.preferences, ...pickPreferences(current.subscription) }),
      });
      if (!response.ok) throw new Error('Push subscription update failed');
      await response.body?.cancel();
    } finally { client.close(); }
  }));
  if (results.some(result => result.status === 'rejected')) throw new Error('Some push subscriptions need another sync');
}
function pickPreferences(value: BackgroundTarget['preferences']) {
  return { aiEnabled: value.aiEnabled, exitEnabled: value.exitEnabled, alertStyle: value.alertStyle, locale: value.locale };
}
const LOG_DATABASE = 'termdock-encrypted-notification-logs';
interface ClickLog { id: string; targetPeerId: string; stage: string; traceId: string; data: unknown; ts: number }
const traceTargets = new Map<string, string>();
let flushing: Promise<void> | undefined;
export async function reportBackgroundNotificationClick(stage: string, traceId: string, data: { targetPeerId?: string }): Promise<void> {
  const targets = await backgroundTargets();
  const target = targets.find(item => item.targetPeerId === (data.targetPeerId || traceTargets.get(traceId))) ?? (targets.length === 1 ? targets[0] : undefined);
  if (!target) return;
  traceTargets.set(traceId, target.targetPeerId);
  if (traceTargets.size > 100) traceTargets.delete(traceTargets.keys().next().value!);
  const item: ClickLog = { id: crypto.randomUUID(), targetPeerId: target.targetPeerId, stage, traceId, data, ts: Date.now() };
  await backgroundStore(store => store.put(item, item.id), true, LOG_DATABASE);
}
export function flushBackgroundNotificationLogs(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    const records = await backgroundStore<ClickLog[]>(store => store.getAll(), false, LOG_DATABASE);
    const targets = await backgroundTargets();
    const fresh = records.filter(item => Date.now() - item.ts < 24 * 60 * 60 * 1000).sort((a, b) => b.ts - a.ts).slice(0, 100);
    for (const item of records) if (!fresh.includes(item)) await backgroundStore(store => store.delete(item.id), true, LOG_DATABASE);
    await Promise.allSettled(targets.map(async target => {
      const items = fresh.filter(item => item.targetPeerId === target.targetPeerId).reverse();
      if (!items.length) return;
      const client = await connectBackgroundTarget(target);
      try {
        for (const item of items) {
          const response = await client.fetch('/api/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ level: 'info', message: `PWA_NOTIFICATION_CLICK ${item.stage}`, data: { traceId: item.traceId, ts: item.ts, detail: item.data } }) });
          if (!response.ok) throw new Error('Notification log delivery failed');
          await response.body?.cancel();
          await backgroundStore(store => store.delete(item.id), true, LOG_DATABASE);
        }
      } finally { client.close(); }
    }));
  })().finally(() => { flushing = undefined; });
  return flushing;
}
