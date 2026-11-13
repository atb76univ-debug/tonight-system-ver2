// ネットワーク優先。通信できない時だけ保存済みの画面を表示する（/api は対象外）
const C = 'tonight-v33-yuinote-design';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // 旧版キャッシュが新しい app.js / CSS の代わりに返されないよう整理
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith('tonight-') && key !== C)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(request).then(response => {
      const copy = response.clone();
      caches.open(C).then(cache => cache.put(request, copy));
      return response;
    }).catch(async () => {
      const cached = await caches.match(request);
      return cached || caches.match('./');
    })
  );
});
