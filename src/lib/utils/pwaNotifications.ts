const PWA_NOTIFICATIONS_ENABLED_KEY = 'termdock-pwa-notifications-enabled';
const PWA_AI_NOTIFICATIONS_ENABLED_KEY = 'termdock-pwa-ai-notifications-enabled';
const PWA_NOTIFICATION_ALERT_STYLE_KEY = 'termdock-pwa-notification-alert-style';
const NOTIFICATION_DEDUPE_STORAGE_PREFIX = 'termdock-notification-claim:';
const NOTIFICATION_DEDUPE_TTL_MS = 5000;
const SW_READY_TIMEOUT_MS = 1500;

export type PwaNotificationAlertStyle = 'normal' | 'quiet' | 'persistent';

export interface PwaNotificationPayload {
  title: string;
  body?: string;
  tag?: string;
  data?: {
    url?: string;
    sessionId?: string;
  };
  requireHidden?: boolean;
  alertStyle?: PwaNotificationAlertStyle;
}

type BrowserNotificationOptions = NotificationOptions & {
  renotify?: boolean;
  vibrate?: VibratePattern;
};

const notificationClaims = new Map<string, number>();

export function isPwaNotificationSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof Notification !== 'undefined'
    && 'serviceWorker' in navigator
    && window.isSecureContext;
}

export function getPwaNotificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export function getStoredPwaNotificationsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(PWA_NOTIFICATIONS_ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setStoredPwaNotificationsEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PWA_NOTIFICATIONS_ENABLED_KEY, String(enabled));
  } catch {
    // localStorage is best-effort; the current in-memory toggle still works.
  }
}

export function getStoredPwaAiNotificationsEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const stored = window.localStorage.getItem(PWA_AI_NOTIFICATIONS_ENABLED_KEY);
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
}

export function setStoredPwaAiNotificationsEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PWA_AI_NOTIFICATIONS_ENABLED_KEY, String(enabled));
  } catch {
    // localStorage is best-effort; the current in-memory toggle still works.
  }
}

export function getStoredPwaNotificationAlertStyle(): PwaNotificationAlertStyle {
  if (typeof window === 'undefined') return 'normal';
  try {
    const stored = window.localStorage.getItem(PWA_NOTIFICATION_ALERT_STYLE_KEY);
    if (stored === 'quiet' || stored === 'persistent') return stored;
  } catch {
    // localStorage is best-effort; fall through to default.
  }
  return 'normal';
}

export function setStoredPwaNotificationAlertStyle(style: PwaNotificationAlertStyle): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PWA_NOTIFICATION_ALERT_STYLE_KEY, style);
  } catch {
    // localStorage is best-effort; the current in-memory selection still works.
  }
}

export async function requestPwaNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isPwaNotificationSupported()) return 'unsupported';

  if (Notification.permission === 'default') {
    return Notification.requestPermission();
  }

  return Notification.permission;
}

function isClientFocused(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible' && document.hasFocus();
}

function pruneNotificationClaims(now: number): void {
  for (const [key, claimedAt] of notificationClaims) {
    if (now - claimedAt > NOTIFICATION_DEDUPE_TTL_MS) {
      notificationClaims.delete(key);
    }
  }
}

function getNotificationClaimKey(payload: PwaNotificationPayload): string {
  if (payload.tag?.trim()) return payload.tag.trim();
  return [payload.data?.sessionId, payload.title, payload.body]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .join('|');
}

function claimNotificationPayload(payload: PwaNotificationPayload): boolean {
  const key = getNotificationClaimKey(payload);
  if (!key) return true;

  const now = Date.now();
  pruneNotificationClaims(now);

  const claimedAt = notificationClaims.get(key) ?? 0;
  if (now - claimedAt < NOTIFICATION_DEDUPE_TTL_MS) {
    return false;
  }

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const storageKey = `${NOTIFICATION_DEDUPE_STORAGE_PREFIX}${key}`;
      const stored = Number(window.localStorage.getItem(storageKey) ?? '0');
      if (Number.isFinite(stored) && now - stored < NOTIFICATION_DEDUPE_TTL_MS) {
        notificationClaims.set(key, stored);
        return false;
      }
      if (Number.isFinite(stored) && stored > 0) {
        window.localStorage.removeItem(storageKey);
      }
      window.localStorage.setItem(storageKey, String(now));
    }
  } catch {
    // Storage is best-effort; in-memory dedupe still prevents same-tab duplicates.
  }

  notificationClaims.set(key, now);
  return true;
}

async function getNotificationRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  try {
    const existing = (await navigator.serviceWorker.getRegistration()) ?? null;
    if (existing?.active) return existing;

    const ready = await Promise.race<ServiceWorkerRegistration | null>([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => {
        window.setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS);
      }),
    ]);

    return ready ?? existing;
  } catch {
    return null;
  }
}

export async function showPwaNotification(payload: PwaNotificationPayload): Promise<boolean> {
  if (!getStoredPwaNotificationsEnabled()) return false;
  if (!isPwaNotificationSupported()) return false;
  if (payload.requireHidden !== false && isClientFocused()) return true;
  if (Notification.permission !== 'granted') return false;
  if (!claimNotificationPayload(payload)) return true;

  const alertStyle = payload.alertStyle ?? getStoredPwaNotificationAlertStyle();
  const notificationOptions: BrowserNotificationOptions = {
    body: payload.body,
    tag: payload.tag,
    icon: '/pwa-192x192.png',
    badge: '/maskable-icon-512x512.png',
    requireInteraction: alertStyle === 'persistent',
    renotify: alertStyle === 'persistent' ? Boolean(payload.tag) : false,
    silent: alertStyle === 'quiet',
    vibrate: alertStyle === 'quiet' ? [] : [80, 40, 80],
    data: {
      url: payload.data?.url ?? '/',
      sessionId: payload.data?.sessionId,
    },
  };

  try {
    const registration = await getNotificationRegistration();
    if (registration && typeof registration.showNotification === 'function') {
      await registration.showNotification(payload.title, notificationOptions);
      return true;
    }

    const notification = new Notification(payload.title, notificationOptions);
    notification.onclick = () => {
      window.focus();
      if (payload.data?.url && window.location.href !== payload.data.url) {
        window.location.assign(payload.data.url);
      }
      notification.close();
    };
    return true;
  } catch (error) {
    console.warn('[PWA notifications] Failed to show notification:', error);
    return false;
  }
}
