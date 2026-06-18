self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const targetUrl = new URL(data.url || '/', self.location.origin).href;

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    for (const client of clients) {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin === self.location.origin && 'focus' in client) {
        await client.focus();
        if ('navigate' in client && client.url !== targetUrl) {
          await client.navigate(targetUrl);
        }
        return;
      }
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});
