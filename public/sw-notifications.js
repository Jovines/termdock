self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};

  event.waitUntil((async () => {
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
