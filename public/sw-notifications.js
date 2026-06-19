self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const targetUrl = new URL(data.url || '/', self.location.origin);
  // 通知带了 sessionId 时，把它拼进 query，让前端打开后直接切到对应 session。
  if (data.sessionId) {
    targetUrl.searchParams.set('session', data.sessionId);
  }
  const targetHref = targetUrl.href;

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    for (const client of clients) {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin === self.location.origin && 'focus' in client) {
        await client.focus();
        // 已有窗口：即使 URL 看似一致也要让前端感知目标 session。优先用 navigate
        // 携带 query；navigate 不可用 / 同 URL 被忽略时，postMessage 兜底。
        if ('navigate' in client && client.url !== targetHref) {
          try {
            await client.navigate(targetHref);
          } catch {
            // navigate 在部分浏览器对受控 client 会抛错，忽略后走 postMessage。
          }
        }
        if (data.sessionId && 'postMessage' in client) {
          client.postMessage({ type: 'termdock:focus-session', sessionId: data.sessionId });
        }
        return;
      }
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});
