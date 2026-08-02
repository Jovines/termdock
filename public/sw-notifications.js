self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Termdock', body: event.data ? event.data.text() : '' };
  }
  const alertStyle = payload.alertStyle || 'normal';
  const notificationOptions = {
    body: payload.body,
    tag: payload.tag,
    icon: '/pwa-192x192.png',
    badge: '/maskable-icon-512x512.png',
    silent: alertStyle === 'quiet',
    requireInteraction: alertStyle === 'persistent',
    renotify: alertStyle === 'persistent' && Boolean(payload.tag),
    data: {
      url: payload.url || '/',
      sessionId: payload.sessionId,
    },
  };
  event.waitUntil((async () => {
    // iOS Safari treats a push that never produces a visible notification as
    // an "invisible push" and revokes the site's permission, and it requires
    // the notification to be posted immediately (not after async work). So
    // the SW always shows it; open windows only get the postMessage so the
    // app could react in place (click focus goes through notificationclick).
    try {
      await self.registration.showNotification(payload.title || 'Termdock', notificationOptions);
    } catch (error) {
      // Safari throws NotSupportedError when renotify:true but no prior
      // notification with the same tag exists.  Retry without renotify —
      // tag-based replacement still works regardless.
      if (error.name === 'NotSupportedError' && notificationOptions.renotify) {
        await self.registration.showNotification(payload.title || 'Termdock', {
          ...notificationOptions,
          renotify: false,
        });
      } else {
        throw error;
      }
    }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (client.visibilityState === 'visible') {
        client.postMessage({ type: 'termdock:push-received', payload });
      }
    }
    if ('setAppBadge' in self.navigator) {
      try {
        const notifications = await self.registration.getNotifications();
        await self.navigator.setAppBadge(notifications.length);
      } catch {
        // Badge accounting is best-effort (iOS lacks getNotifications).
      }
    }
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const statusResponse = await fetch('/api/notifications/status', { credentials: 'same-origin' });
      if (statusResponse.ok) {
        const status = await statusResponse.json();
        const subscription = event.newSubscription || await self.registration.pushManager.getSubscription();
        if (subscription) {
          const tokenResponse = await fetch('/api/csrf-token', { credentials: 'same-origin' });
          if (tokenResponse.ok) {
            const { csrfToken } = await tokenResponse.json();
            await fetch('/api/notifications/subscribe', {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                'Content-Type': 'application/json',
                'X-XSRF-TOKEN': csrfToken,
              },
              body: JSON.stringify({
                subscription: subscription.toJSON(),
                aiEnabled: status.subscription?.aiEnabled !== false,
                exitEnabled: status.subscription?.exitEnabled === true,
                alertStyle: status.subscription?.alertStyle || 'normal',
                locale: status.subscription?.locale || 'zh-CN',
              }),
            });
          }
        }
      }
    } catch {
      // App foreground reconciliation is the fallback for browsers that do not
      // permit re-subscription inside pushsubscriptionchange.
    }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      client.postMessage({ type: 'termdock:push-subscription-changed' });
    }
  })());
});

async function reportNotificationClick(stage, traceId, data = {}) {
  try {
    await fetch('/api/client-log', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: 'info',
        message: `PWA_NOTIFICATION_CLICK ${stage}`,
        data: { traceId, ts: Date.now(), ...data },
      }),
    });
  } catch {
    // Diagnostics must never interfere with notification navigation.
  }
}

const NOTIFICATION_TARGET_CACHE = 'termdock-notification-target-v1';
const NOTIFICATION_TARGET_KEY = '/__termdock-notification-target';

async function storeNotificationTarget(sessionId, traceId) {
  if (!sessionId || typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open(NOTIFICATION_TARGET_CACHE);
    await cache.put(NOTIFICATION_TARGET_KEY, new Response(JSON.stringify({
      sessionId,
      traceId,
      clickedAt: Date.now(),
    }), { headers: { 'Content-Type': 'application/json' } }));
    return true;
  } catch {
    return false;
  }
}

async function clearStoredNotificationTarget() {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(NOTIFICATION_TARGET_CACHE);
    await cache.delete(NOTIFICATION_TARGET_KEY);
  } catch {
    // The page-side consumer remains the fallback.
  }
}

function requestFocusAcknowledgement(client, sessionId) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (acknowledged) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      channel.port1.close();
      resolve(acknowledged);
    };
    const timeout = setTimeout(() => finish(false), 1000);
    channel.port1.onmessage = (messageEvent) => {
      finish(messageEvent.data?.type === 'termdock:focus-session-ack');
    };
    try {
      client.postMessage(
        { type: 'termdock:focus-session', sessionId },
        [channel.port2],
      );
    } catch {
      finish(false);
    }
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const traceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  event.waitUntil((async () => {
    await reportNotificationClick('sw-click-start', traceId, {
      sessionId: data.sessionId || null,
      url: data.url || null,
      tag: event.notification.tag || null,
    });
    const targetStored = await storeNotificationTarget(data.sessionId, traceId);
    await reportNotificationClick('sw-target-stored', traceId, { stored: targetStored });

    // Badge cleanup is strictly best-effort. iOS may expose setAppBadge while
    // ServiceWorkerRegistration.getNotifications is unavailable; allowing that
    // TypeError to escape aborts the entire click handler before navigation.
    try {
      if (
        'setAppBadge' in self.navigator
        && typeof self.registration.getNotifications === 'function'
      ) {
        const notifications = await self.registration.getNotifications();
        await self.navigator.setAppBadge(Math.max(0, notifications.length - 1));
        await reportNotificationClick('sw-badge-updated', traceId, { count: notifications.length });
      } else {
        await reportNotificationClick('sw-badge-api-unavailable', traceId, {
          hasSetAppBadge: 'setAppBadge' in self.navigator,
          hasGetNotifications: typeof self.registration.getNotifications === 'function',
        });
      }
    } catch (error) {
      await reportNotificationClick('sw-badge-failed', traceId, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    await reportNotificationClick('sw-clients-matched', traceId, {
      count: clients.length,
      clients: clients.map((client) => ({ url: client.url, visibilityState: client.visibilityState })),
    });

    // 已有窗口：focus + postMessage 原地切换。冷启动时 iOS 会先创建
    // WindowClient，但页面监听器尚未挂载；此时不再 navigate（会生成
    // 第二个页面），而由冷启动页从 Cache Storage 消费持久化的目标。
    for (const client of clients) {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin === self.location.origin && 'focus' in client) {
        await client.focus();
        const acknowledged = data.sessionId && 'postMessage' in client
          ? await requestFocusAcknowledgement(client, data.sessionId)
          : false;
        await reportNotificationClick('sw-focus-ack-result', traceId, {
          acknowledged,
          clientUrl: client.url,
          visibilityState: client.visibilityState,
        });
        if (acknowledged) await clearStoredNotificationTarget();
        else await reportNotificationClick('sw-cache-fallback', traceId, { clientUrl: client.url });
        return;
      }
    }

    // 无已有窗口：打开新窗口并标记 _notif=1，前端检测到有其他实例在场时自动关闭。
    if (self.clients.openWindow) {
      const targetUrl = new URL(data.url || '/', self.location.origin);
      if (data.sessionId) {
        targetUrl.searchParams.set('session', data.sessionId);
      }
      targetUrl.searchParams.set('_notif', '1');
      targetUrl.searchParams.set('_notifTrace', traceId);
      const openedClient = await self.clients.openWindow(targetUrl.href);
      await reportNotificationClick('sw-open-window-result', traceId, {
        targetUrl: targetUrl.href,
        opened: Boolean(openedClient),
        resultUrl: openedClient?.url || null,
      });
    }
  })());
});
