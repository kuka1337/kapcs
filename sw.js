/**
 * KAPCS Service Worker — PWA + Offline támogatás
 */

const CACHE_NAME = 'kapcs-v3';
const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.json'
];

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>KAPCS — Offline</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0a0e17;color:#f8fafc;font-family:"DM Sans",system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px}
    .icon{font-size:64px;margin-bottom:20px;animation:float 3s ease-in-out infinite}
    @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-12px)}}
    h1{font-size:28px;font-weight:800;margin-bottom:8px;font-family:system-ui}
    p{font-size:14px;color:#94a3b8;max-width:320px;line-height:1.6;margin-bottom:24px}
    .btn{background:#6366f1;color:#fff;border:0;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:8px}
    .btn:hover{background:#4f46e5}
    .status{font-size:11px;color:#64748b;margin-top:16px}
  </style>
</head>
<body>
  <div>
    <div class="icon">🤡</div>
    <h1>You're offline</h1>
    <p>KAPCS requires an internet connection for video chat. Check your connection and try again.</p>
    <button class="btn" onclick="location.reload()">↺ Try Again</button>
    <div class="status" id="s">Checking connection...</div>
  </div>
  <script>
    setInterval(()=>{
      fetch('/manifest.json',{cache:'no-store'}).then(()=>{
        document.getElementById('s').textContent='✅ Connection restored — reloading...';
        setTimeout(()=>location.reload(),1000);
      }).catch(()=>{
        document.getElementById('s').textContent='Still offline...';
      });
    },3000);
  </script>
</body>
</html>`;

// ── INSTALL ───────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Shell fájlok + offline oldal cache-elése
      cache.addAll(SHELL_URLS).catch(() => {});
      // Offline HTML string-et is tároljuk
      return cache.put('/_offline', new Response(OFFLINE_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      }));
    }).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH ─────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API hívások, MQTT, PeerJS, külső CDN → mindig network
  if (
    url.hostname.includes('broker.emqx') ||
    url.hostname.includes('ipapi.co') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('cdn.jsdelivr') ||
    url.hostname.includes('fonts.googleapis') ||
    url.hostname.includes('0.peerjs.com') ||
    url.pathname.startsWith('/api/') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  // Navigációs kérések (HTML oldalak) → Network First, offline fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Frissítjük a cache-t
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request)
          .then(cached => cached || caches.match('/_offline'))
        )
    );
    return;
  }

  // Statikus assetek → Cache First, Network Fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        if (event.request.destination === 'document') return caches.match('/_offline');
      });
    })
  );
});

// ── PUSH NOTIFICATIONS ────────────────────────────────────────
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || '🤡 KAPCS', {
      body: data.body || 'New activity on KAPCS.',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'kapcs-notification',
      renotify: true,
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      return clients.openWindow(event.notification.data?.url || '/');
    })
  );
});
