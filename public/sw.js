/*
 * Porchlight's service worker. It does two things and nothing else:
 * shows a notification when the server pushes one, and opens the right
 * page when it's tapped. No caching, no offline mode - every screen in
 * this app is live data, and a cached one would be a stale lie.
 *
 * Served from the root so its scope is the whole app, and never cached
 * by the CDN (public/_headers), so a new version is picked up on the
 * next visit.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }

  // Every push must show something: Safari revokes the subscription of a
  // site that receives pushes silently, and Chrome shows its own generic
  // message instead.
  event.waitUntil(
    self.registration.showNotification(data.title || 'Porchlight', {
      body: data.body || '',
      tag: data.tag,
      // A second ring replaces the first (same tag) but must still alert.
      renotify: Boolean(data.tag),
      timestamp: data.timestamp,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = event.notification.data?.url || '/';

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);

      // An open app moves to the page itself, through its router, rather
      // than being reloaded - see usePushNavigation.
      if (open) {
        await open.focus();
        open.postMessage({ type: 'porchlight:open', url: path });
        return;
      }
      await self.clients.openWindow(path);
    })()
  );
});
