/**
 * KAPCS Service Worker — PWA támogatás
 *
 * Stratégia:
 *  - Shell fájlok (HTML, CSS, fonts) → Cache First
 *  - API hívások (MQTT, ipapi) → Network Only (nem cache-eljük)
 *  - Offline fallback: ha nincs net és nincs cache → offline.html
 */

const CACHE_NAME = 'kapcs-v2';
const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;700&family=Outfit:wght@700;800&family=JetBrains+Mono:wght@500;700&display=swap'
];

// ── INSTALL: shell fájlok előre cache-elése ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(SHELL_URLS).catch(() => {
        // Ha egy URL nem töltődik be (pl. offline), folytassuk tovább
      });
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: régi cache-ek törlése ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: kérések kezelése ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // MQTT, API hívások, MediaDevices → Network Only (soha nem cache-eljük)
  if (
    url.hostname.includes('mqtt') ||
    url.hostname.includes('broker.emqx') ||
    url.hostname.includes('ipapi.co') ||
    url.hostname.includes('peerjs') ||
    url.pathname.startsWith('/api/') ||
    event.request.method !== 'GET'
  ) {
    return; // böngésző alapértelmezett viselkedése
  }

  // Shell fájlok és statikus assetek → Cache First, Network Fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        // Csak siker esetén cache-eljük
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback HTML oldalra
        if (event.request.destination === 'document') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

// ── PUSH NOTIFICATION (jövőbeli bővítéshez előkészítve) ──
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'KAPCS', {
      body: data.body || 'New activity on KAPCS.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'kapcs-notification'
    })
  );
});
