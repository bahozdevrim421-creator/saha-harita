// Service worker: app shell cache, runtime cache for OSM tiles and CDN files.
// Supabase API traffic is never cached. Bump SHELL_VERSION on each deploy that changes files.
const SHELL_VERSION = 'v3';
const SHELL_CACHE = `saha-shell-${SHELL_VERSION}`;
const TILE_CACHE = 'saha-tiles-v1';
const TILE_MAX = 3000;

const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './js/app.js',
  './js/auth.js',
  './js/csv.js',
  './js/db.js',
  './js/durum.js',
  './js/geo.js',
  './js/gps.js',
  './js/ids.js',
  './js/importer.js',
  './js/konum.js',
  './js/mapview.js',
  './js/outbox.js',
  './js/overpass.js',
  './js/route.js',
  './js/sales.js',
  './js/seed.js',
  './js/settings.js',
  './js/store.js',
  './js/sync.js',
  './js/tracking.js',
  './vendor/leaflet.css',
  './vendor/leaflet.js',
];

const CDN_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net'];
const isTile = (url) => url.hostname.endsWith('tile.openstreetmap.org');
const isSupabase = (url) => url.hostname.endsWith('supabase.co');

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Add files one by one so one failing CDN request does not block the install.
    await Promise.all(SHELL_FILES.map((f) => cache.add(f).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('saha-shell-') && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length > max) {
    for (const req of keys.slice(0, keys.length - max)) await cache.delete(req);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache Supabase API or realtime traffic.
  if (isSupabase(url)) return;

  // Overpass downloads are stored by the app in IndexedDB, not in the cache.
  if (url.hostname === 'overpass-api.de') return;

  // OSM tiles: cache as they are viewed, serve from cache when offline.
  if (isTile(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') {
          cache.put(req, res.clone());
          trimCache(TILE_CACHE, TILE_MAX);
        }
        return res;
      } catch {
        return new Response('', { status: 504, statusText: 'offline' });
      }
    })());
    return;
  }

  // App shell and CDN files: cache first, then network (and store the result).
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin || CDN_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(req, { ignoreSearch: false });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      } catch {
        if (req.mode === 'navigate') {
          const fallback = await cache.match('./index.html');
          if (fallback) return fallback;
        }
        return new Response('', { status: 504, statusText: 'offline' });
      }
    })());
  }
});
