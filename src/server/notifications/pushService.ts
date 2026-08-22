import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import webpush, { type PushSubscription } from 'web-push';
import { getForegroundPushClientIds } from './pushViewers.js';

export type PushAlertStyle = 'normal' | 'quiet' | 'persistent';

export interface StoredPushSubscription {
  clientId: string;
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
  aiEnabled: boolean;
  /** Opt-in: notify when a terminal process exits on its own. */
  exitEnabled: boolean;
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
      // Subscriptions written before exitEnabled existed default to opt-out.
      store = {
        ...parsed,
        subscriptions: parsed.subscriptions.map((entry) => ({
          ...entry,
          exitEnabled: entry.exitEnabled === true,
        })),
      } as PushStore;
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
  // VAPID subject must be a mailto: or https: contact URI. Configurable for
  // self-hosters; defaults to the project repository instead of a fake mailbox.
  const vapidSubject = process.env.TERMDOCK_VAPID_SUBJECT?.trim()
    || 'https://github.com/Jovines/termdock';
  webpush.setVapidDetails(vapidSubject, store.vapid.publicKey, store.vapid.privateKey);
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
  preferences: Pick<StoredPushSubscription, 'aiEnabled' | 'alertStyle' | 'locale'>
    & Partial<Pick<StoredPushSubscription, 'exitEnabled'>>,
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

export type AgentNotificationKind = 'waiting' | 'done' | 'exited';

function isZhLocale(locale: string): boolean {
  return locale.toLowerCase().startsWith('zh');
}

/**
 * Localized push copy, mirroring the client-side getAgentNotificationText in
 * useTerminalStore.ts so both delivery paths read the same for one locale.
 */
export function agentNotificationText(
  locale: string,
  kind: AgentNotificationKind,
  agentName: string,
): { title: string; body: string } {
  if (isZhLocale(locale)) {
    if (kind === 'waiting') return { title: `${agentName} 需要你的处理`, body: '点按返回对应会话' };
    if (kind === 'done') return { title: `${agentName} 已完成`, body: '点按查看结果' };
    return { title: `${agentName} 已退出`, body: '点按查看结果' };
  }
  if (kind === 'waiting') return { title: `${agentName} needs your input`, body: 'Tap to return to the session' };
  if (kind === 'done') return { title: `${agentName} finished`, body: 'Tap to see the result' };
  return { title: `${agentName} exited`, body: 'Tap to see the result' };
}

export function terminalExitText(
  locale: string,
  exitCode: number | null,
): { title: string; body: string } {
  if (isZhLocale(locale)) {
    return {
      title: '终端会话已退出',
      body: exitCode !== null ? `进程已退出(代码 ${exitCode}),点按查看` : '进程已退出,点按查看',
    };
  }
  return {
    title: 'Terminal session ended',
    body: exitCode !== null ? `Process exited (code ${exitCode}). Tap to view.` : 'Process exited. Tap to view.',
  };
}

async function sendPayload(options: {
  enabled: (entry: StoredPushSubscription) => boolean;
  urgency?: 'high' | 'normal';
  /** Delivery window before the push service drops the message. Waiting
   *  states routinely outlive an hour (user away from the phone), so they
   *  get a much longer window; done/exit are fresher. */
  ttlSeconds?: number;
  /** Push clientIds currently viewing the session — their push would pop
   *  over content they are already looking at, so skip them. */
  skipClientIds?: ReadonlySet<string>;
  build: (locale: string) => Record<string, unknown>;
}): Promise<void> {
  const current = readStore();
  const invalidEndpoints = new Set<string>();
  await Promise.all(current.subscriptions.filter((entry) => (
    options.enabled(entry) && !options.skipClientIds?.has(entry.clientId)
  )).map(async (entry) => {
    try {
      const subscription: PushSubscription = {
        endpoint: entry.endpoint,
        expirationTime: entry.expirationTime,
        keys: entry.keys,
      };
      await webpush.sendNotification(subscription, JSON.stringify({
        ...options.build(entry.locale),
        alertStyle: entry.alertStyle,
        locale: entry.locale,
      }), {
        TTL: options.ttlSeconds ?? 60 * 60,
        urgency: options.urgency ?? 'normal',
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
  const agentExited = (current.agentStatus === null || current.agentStatus === 'idle')
    && (previous?.agentStatus === 'working' || previous?.agentStatus === 'waiting');
  const kind = (agentExited ? 'exited' : current.agentStatus) as AgentNotificationKind;
  const agentName = current.agent?.displayName ?? previous?.agent?.displayName ?? 'Agent';
  void sendPayload({
    enabled: (entry) => entry.aiEnabled,
    skipClientIds: getForegroundPushClientIds(),
    urgency: kind === 'waiting' ? 'high' : 'normal',
    ttlSeconds: kind === 'waiting' ? 24 * 60 * 60 : 60 * 60,
    build: (locale) => {
      const text = agentNotificationText(locale, kind, agentName);
      return {
        kind,
        title: text.title,
        body: current.agentMessage ?? text.body,
        // Same tag for all transitions of one session → new notification
        // replaces the old one (key behaviour on iOS where getNotifications()
        // is unavailable for programmatic cleanup).
        tag: `agent:${sessionId}`,
        // Per-transition key so the 5 s dedup window only suppresses
        // duplicate deliveries of the same transition, not later ones.
        dedupKey: `agent:${sessionId}:${kind}:${current.agentActivity}`,
        sessionId,
        url: `/?session=${encodeURIComponent(sessionId)}`,
      };
    },
  });
}

/**
 * Push for a terminal process that exited on its own (not a user-initiated
 * close — those dispose the exit listener before killing the pty). Sessions
 * with a live agent are covered by notifyAgentTransition instead, so the
 * caller skips those to avoid double notifications for one event.
 */
export function notifyTerminalExit(sessionId: string, exitCode: number | null): void {
  void sendPayload({
    enabled: (entry) => entry.exitEnabled,
    skipClientIds: getForegroundPushClientIds(),
    build: (locale) => {
      const text = terminalExitText(locale, exitCode);
      return {
        kind: 'exit',
        title: text.title,
        body: text.body,
        tag: `exit:${sessionId}`,
        dedupKey: `exit:${sessionId}:${exitCode ?? 'signal'}`,
        sessionId,
        url: `/?session=${encodeURIComponent(sessionId)}`,
      };
    },
  });
}

export function shouldNotifyAgentTransition(
  previous: AgentPushState | null,
  current: AgentPushState,
): boolean {
  if (!previous) return false;
  // Only status or activity changes carry new information. A `reviewed` flip
  // is the user's own acknowledgement (or a stop stamping an unread turn) and
  // must not re-notify by itself — the previous reviewed-based gate here
  // silently suppressed every mid-turn waiting event, because reviewed stays
  // true while an agent is working or waiting and only `stop` clears it.
  const stateChanged = previous.agentStatus !== current.agentStatus
    || previous.agentActivity !== current.agentActivity;
  if (!stateChanged) return false;

  if (current.agentStatus === 'waiting' || current.agentStatus === 'done') {
    // waiting: any new wait event (entering waiting, or a new activity round
    // while waiting) deserves a push. done: only entering done — a second
    // stop for the same turn, or an ack-only broadcast, must stay silent.
    return current.agentStatus === 'waiting' || previous.agentStatus !== 'done';
  }

  // Agent exited: from working or waiting (including a hook-emitted
  // session-end that lands on 'idle' before the process poll clears the
  // session). done → exit is deliberately silent — the completion was
  // already notified.
  return (current.agentStatus === null || current.agentStatus === 'idle')
    && (previous.agentStatus === 'working' || previous.agentStatus === 'waiting');
}
