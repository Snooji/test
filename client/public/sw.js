// Starside Movers service worker: app shell offline-ready, game data always live.
const CACHE = 'starside-v2'; // bump to drop every old cached file
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png']).catch(() => {}))); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (/^\/(api|admin|confirm|unsubscribe|health|matchmake|privacy)/.test(url.pathname)) return; // always live
  if (/\.(png|webmanifest)$/.test(url.pathname) && !url.pathname.startsWith('/assets/')) {
    // icons, share image, manifest: same name when they change, so network first, cache when offline
    e.respondWith(fetch(e.request).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; }).catch(() => caches.match(e.request)));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    // hashed build files never change: cache first
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })));
    return;
  }
  if (e.request.mode === 'navigate') {
    // pages: network first so new versions show up immediately, cache as the offline fallback
    e.respondWith(fetch(e.request).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('/', copy)); return res; }).catch(() => caches.match('/')));
  }
});
