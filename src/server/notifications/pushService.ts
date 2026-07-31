import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import webpush, { type PushSubscription } from 'web-push';

export type PushAlertStyle = 'normal' | 'quiet' | 'persistent';

export interface StoredPushSubscription {
  clientId: string;
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
  aiEnabled: boolean;
  alertStyle: PushAlertStyle;
  locale: string;
  updatedAt: number;
}

interface PushStore {
  version: 1;
  vapid: { publicKey: string; privateKey: string };
  subscriptions: StoredPushSubscription[];
}

export interface AgentPushState {
  agentStatus: string | null;
  agentMessage: string | null;
  agentActivity: number;
  reviewed: boolean | null;
  agent: { displayName: string } | null;
}

const storeDirectory = path.join(os.homedir(), '.termdock');
const storePath = path.join(storeDirectory, 'push-notifications.json');
let store: PushStore | null = null;

function persistStore(next: PushStore): void {
  fs.mkdirSync(storeDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, storePath);
}

function readStore(): PushStore {
  if (store) return store;
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Partial<PushStore>;
    if (
      parsed.version === 1
      && typeof parsed.vapid?.publicKey === 'string'
      && typeof parsed.vapid?.privateKey === 'string'
      && Array.isArray(parsed.subscriptions)
    ) {
      store = parsed as PushStore;
    }
  } catch {
    // First run or damaged state: create a stable local key pair.
  }
  if (!store) {
    store = {
      version: 1,
      vapid: webpush.generateVAPIDKeys(),
      subscriptions: [],
    };
    persistStore(store);
  }
  webpush.setVapidDetails('mailto:push@termdock.local', store.vapid.publicKey, store.vapid.privateKey);
  return store;
}

export function getVapidPublicKey(): string {
  return readStore().vapid.publicKey;
}

export function getPushSubscription(clientId: string): StoredPushSubscription | null {
  return readStore().subscriptions.find((entry) => entry.clientId === clientId) ?? null;
}

export function upsertPushSubscription(
  clientId: string,
  subscription: Omit<StoredPushSubscription, 'clientId' | 'updatedAt'>,
): StoredPushSubscription {
  const current = readStore();
  const next = { ...subscription, clientId, updatedAt: Date.now() };
  current.subscriptions = current.subscriptions.filter(
    (entry) => entry.clientId !== clientId && entry.endpoint !== subscription.endpoint,
  );
  current.subscriptions.push(next);
  persistStore(current);
  return next;
}

export function updatePushPreferences(
  clientId: string,
  preferences: Pick<StoredPushSubscription, 'aiEnabled' | 'alertStyle' | 'locale'>,
): StoredPushSubscription | null {
  const current = readStore();
  const subscription = current.subscriptions.find((entry) => entry.clientId === clientId);
  if (!subscription) return null;
  Object.assign(subscription, preferences, { updatedAt: Date.now() });
  persistStore(current);
  return subscription;
}

export function removePushSubscription(clientId: string, endpoint?: string): void {
  const current = readStore();
  const previousLength = current.subscriptions.length;
  current.subscriptions = current.subscriptions.filter(
    (entry) => entry.clientId !== clientId && (!endpoint || entry.endpoint !== endpoint),
  );
  if (current.subscriptions.length !== previousLength) persistStore(current);
}

async function sendPayload(payload: Record<string, unknown>): Promise<void> {
  const current = readStore();
  const invalidEndpoints = new Set<string>();
  await Promise.all(current.subscriptions.filter((entry) => entry.aiEnabled).map(async (entry) => {
    try {
      const subscription: PushSubscription = {
        endpoint: entry.endpoint,
        expirationTime: entry.expirationTime,
        keys: entry.keys,
      };
      await webpush.sendNotification(subscription, JSON.stringify({
        ...payload,
        alertStyle: entry.alertStyle,
        locale: entry.locale,
      }), {
        TTL: 60 * 60,
        urgency: payload.kind === 'waiting' ? 'high' : 'normal',
      });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        invalidEndpoints.add(entry.endpoint);
      } else {
        console.warn('[push] Delivery failed:', error);
      }
    }
  }));
  if (invalidEndpoints.size > 0) {
    current.subscriptions = current.subscriptions.filter(
      (entry) => !invalidEndpoints.has(entry.endpoint),
    );
    persistStore(current);
  }
}

export function notifyAgentTransition(
  sessionId: string,
  previous: AgentPushState | null,
  current: AgentPushState,
): void {
  if (!shouldNotifyAgentTransition(previous, current)) return;
  const agentExited = current.agentStatus === null && previous?.agentStatus === 'working';
  const kind = agentExited ? 'exited' : current.agentStatus;
  const agentName = current.agent?.displayName ?? previous?.agent?.displayName ?? 'Agent';
  const title = kind === 'waiting'
    ? `${agentName} 需要你的处理`
    : kind === 'done'
      ? `${agentName} 已完成`
      : `${agentName} 已退出`;
  void sendPayload({
    kind,
    title,
    body: current.agentMessage ?? (kind === 'waiting' ? '点按返回对应会话' : '点按查看结果'),
    // Same tag for all transitions of one session → new notification
    // replaces the old one (key behaviour on iOS where getNotifications()
    // is unavailable for programmatic cleanup).
    tag: `agent:${sessionId}`,
    // Per-transition key so the 5 s dedup window only suppresses
    // duplicate deliveries of the same transition, not later ones.
    dedupKey: `agent:${sessionId}:${kind}:${current.agentActivity}`,
    sessionId,
    url: `/?session=${encodeURIComponent(sessionId)}`,
  });
}

export function shouldNotifyAgentTransition(
  previous: AgentPushState | null,
  current: AgentPushState,
): boolean {
  if (!previous) return false;
  const needsAttention = current.reviewed !== true
    && (current.agentStatus === 'waiting' || current.agentStatus === 'done');
  const attentionChanged = previous.agentStatus !== current.agentStatus
    || previous.agentActivity !== current.agentActivity
    || previous.reviewed === true;
  const agentExited = current.agentStatus === null
    && previous.agentStatus === 'working'
    && current.reviewed !== true;
  return (needsAttention && attentionChanged) || agentExited;
}
