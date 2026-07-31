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

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};

  event.waitUntil((async () => {
    if ('setAppBadge' in self.navigator) {
      const notifications = await self.registration.getNotifications();
      await self.navigator.setAppBadge(Math.max(0, notifications.length - 1));
    }
    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    // 已有窗口：聚焦并通过 postMessage 让 SPA 内切换 tab，不 navigate（避免整页重载）。
    for (const client of clients) {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin === self.location.origin && 'focus' in client) {
        await client.focus();
        if (data.sessionId && 'postMessage' in client) {
          client.postMessage({ type: 'termdock:focus-session', sessionId: data.sessionId });
        }
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
      await self.clients.openWindow(targetUrl.href);
    }
  })());
});
