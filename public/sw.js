// Service Worker: App-Shell offline, Höhenkacheln dauerhaft im Cache (Offline am Berg).
const VERSION = 'v2';
const SHELL = `ridge-lens-shell-${VERSION}`;
const TILES = 'ridge-lens-tiles-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['./', './manifest.webmanifest', './icons/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ridge-lens-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(req)) ?? (await cache.match('./'));
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 's3.amazonaws.com' && url.pathname.startsWith('/elevation-tiles-prod/')) {
    e.respondWith(cacheFirst(TILES, req));
  } else if (url.origin === self.location.origin) {
    // Gehashte Assets ändern sich nie; HTML/Manifest immer frisch, offline aus Cache
    e.respondWith(url.pathname.includes('/assets/') ? cacheFirst(SHELL, req) : networkFirst(req));
  }
});
