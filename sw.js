// Pit Wall service worker: keeps the app itself on the phone so it opens instantly and offline.
// Bump VERSION whenever the app files change; the phone picks the new version up on its next launch.
const VERSION = 'pw-1.0.0';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
const FONT = 'pw-font-1';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = [VERSION, FONT, 'pw-data-1'];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The app itself: answer from the phone at once, fetch a fresh copy in the background.
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const key = req.mode === 'navigate' ? 'index.html' : req;
      const hit = await c.match(key, { ignoreSearch: true });
      const fresh = fetch(req).then(r => { if (r.ok && req.mode !== 'navigate') c.put(req, r.clone()); return r; }).catch(() => null);
      return hit || (await fresh) || new Response('Offline', { status: 503 });
    })());
    return;
  }

  // Fonts: keep forever.
  if (url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONT).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok || r.type === 'opaque') c.put(req, r.clone());
      return r;
    }));
    return;
  }

  // Photos use the browser's own cache. Data requests (Jolpica, OpenF1, ESPN...) are cached by the app itself.
});
