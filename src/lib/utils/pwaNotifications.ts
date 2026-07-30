const PWA_NOTIFICATIONS_ENABLED_KEY = 'termdock-pwa-notifications-enabled';
const PWA_AI_NOTIFICATIONS_ENABLED_KEY = 'termdock-pwa-ai-notifications-enabled';
const PWA_NOTIFICATION_ALERT_STYLE_KEY = 'termdock-pwa-notification-alert-style';
const NOTIFICATION_DEDUPE_STORAGE_PREFIX = 'termdock-notification-claim:';
const NOTIFICATION_DEDUPE_TTL_MS = 5000;
const SW_READY_TIMEOUT_MS = 1500;
const PUSH_SYNC_STORAGE_KEY = 'termdock-push-last-sync';
const PUSH_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PUSH_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
  if (getTermdockDesktopBridge()) return true;
  return typeof window !== 'undefined'
    && typeof Notification !== 'undefined'
    && 'serviceWorker' in navigator
    && window.isSecureContext;
}
/** Detect whether the current browser is iOS Safari / iPadOS Safari. */
export function isIOSSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Whether the PWA is running in standalone (installed to Home Screen) mode.
 * On iOS this is the only way Web Push notifications are actually delivered.
 */
export function isPwaStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  // Safari iOS standalone sets navigator.standalone = true
  if ('standalone' in navigator && (navigator as any).standalone === true) return true;
  return false;
}

/**
 * Whether notifications are actually deliverable (API supported AND not blocked
 * by platform restrictions such as iOS requiring standalone PWA mode).
 *
 * isPwaNotificationSupported() checks raw API availability; this function
 * tells you whether showPwaNotification() will actually produce a notification.
 */
export function isPwaNotificationEffective(): boolean {
  if (getTermdockDesktopBridge()) return true;
  if (!isPwaNotificationSupported()) return false;
  // iOS Safari only delivers notifications in standalone PWA mode (iOS 16.4+).
  if (isIOSSafari() && !isPwaStandalone()) return false;
  return true;
}



export function getPwaNotificationPermission(): NotificationPermission | 'unsupported' {
  if (getTermdockDesktopBridge()) return 'granted';
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
  if (getTermdockDesktopBridge()) return 'granted';
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

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const bytes = window.atob(base64);
  const output = new Uint8Array(new ArrayBuffer(bytes.length));
  for (let index = 0; index < bytes.length; index += 1) output[index] = bytes.charCodeAt(index);
  return output;
}

async function notificationMutation(path: string, body: unknown): Promise<Response> {
  const tokenResponse = await fetch('/api/csrf-token');
  if (!tokenResponse.ok) throw new Error('Unable to get notification security token');
  const { csrfToken } = await tokenResponse.json() as { csrfToken: string };
  return fetch(`/api/notifications/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': csrfToken,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Reconciles the browser's rotating PushSubscription with the server.
 * Called on launch, foreground resume, and periodically while the app is open.
 */
export async function syncPwaPushSubscription(force = false, allowCreate = false): Promise<boolean> {
  if (getTermdockDesktopBridge()) return true;
  if (!getStoredPwaNotificationsEnabled() || !isPwaNotificationEffective()) return false;
  if (Notification.permission !== 'granted') return false;
  const registration = await getNotificationRegistration();
  if (!registration?.pushManager) return false;

  try {
    const statusResponse = await fetch('/api/notifications/status');
    if (!statusResponse.ok) return false;
    const status = await statusResponse.json() as {
      publicKey: string;
      subscription: { endpoint?: string; updatedAt?: number } | null;
    };
    let subscription = await registration.pushManager.getSubscription();
    const expiresSoon = Boolean(
      subscription?.expirationTime
      && subscription.expirationTime - Date.now() < PUSH_RENEWAL_WINDOW_MS,
    );
    if (!subscription) {
      // The initial subscribe must remain inside the settings-button user
      // gesture on iOS and some Chromium builds. Rotation normally leaves a
      // replacement subscription for us to upload without another prompt.
      if (!allowCreate) return false;
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(status.publicKey),
      });
    }

    const lastSync = Number(window.localStorage.getItem(PUSH_SYNC_STORAGE_KEY) ?? '0');
    const serverIsStale = !status.subscription
      || status.subscription.endpoint !== subscription.endpoint
      || Date.now() - (status.subscription.updatedAt ?? 0) >= PUSH_SYNC_INTERVAL_MS;
    if (force || serverIsStale || Date.now() - lastSync >= PUSH_SYNC_INTERVAL_MS || expiresSoon) {
      const response = await notificationMutation('subscribe', {
        subscription: subscription.toJSON(),
        aiEnabled: getStoredPwaAiNotificationsEnabled(),
        alertStyle: getStoredPwaNotificationAlertStyle(),
        locale: navigator.language,
      });
      if (!response.ok) return false;
      window.localStorage.setItem(PUSH_SYNC_STORAGE_KEY, String(Date.now()));
    }
    return true;
  } catch (error) {
    console.warn('[PWA notifications] Push subscription sync failed:', error);
    return false;
  }
}

export async function unsubscribePwaPush(): Promise<void> {
  if (getTermdockDesktopBridge()) return;
  const registration = await getNotificationRegistration();
  const subscription = await registration?.pushManager?.getSubscription();
  try {
    await notificationMutation('unsubscribe', { endpoint: subscription?.endpoint });
  } finally {
    await subscription?.unsubscribe();
    try {
      window.localStorage.removeItem(PUSH_SYNC_STORAGE_KEY);
    } catch {
      // Best-effort cache cleanup.
    }
  }
}

export async function syncPwaPushPreferences(): Promise<void> {
  if (getTermdockDesktopBridge()) return;
  if (!getStoredPwaNotificationsEnabled()) return;
  const response = await notificationMutation('preferences', {
    aiEnabled: getStoredPwaAiNotificationsEnabled(),
    alertStyle: getStoredPwaNotificationAlertStyle(),
    locale: navigator.language,
  });
  if (response.status === 404) await syncPwaPushSubscription(true);
}

export async function showPwaNotification(payload: PwaNotificationPayload): Promise<boolean> {
  if (!getStoredPwaNotificationsEnabled()) return false;
  if (!isPwaNotificationSupported()) return false;
  if (payload.requireHidden !== false && isClientFocused()) return true;
  const desktopBridge = getTermdockDesktopBridge();
  if (desktopBridge) {
    const alertStyle = payload.alertStyle ?? getStoredPwaNotificationAlertStyle();
    return desktopBridge.showNotification({
      title: payload.title,
      body: payload.body,
      tag: payload.tag,
      sessionId: payload.data?.sessionId,
      silent: alertStyle === 'quiet',
    });
  }
  if (Notification.permission !== 'granted') return false;
  const registration = await getNotificationRegistration();
  if (await registration?.pushManager?.getSubscription()) {
    // The server-side Web Push path covers background and closed-PWA delivery.
    return true;
  }
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
import { getTermdockDesktopBridge } from '../desktop/nativeBridge';
