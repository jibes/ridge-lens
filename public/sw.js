// Service Worker: App-Shell offline, Höhen- und Gipfelkacheln dauerhaft im Cache (Offline am Berg).
const VERSION = 'v3';
const SHELL = `ridge-lens-shell-${VERSION}`;
// Namen auch in src/offline.ts (Vorab-Download legt direkt in diese Caches)
const TILES = 'ridge-lens-tiles-v1';
const PEAKS = 'ridge-lens-peaks-data-v1';
/** Höchstzahl Höhenkacheln (≈ 100 kB je Kachel → rund 400 MB); älteste fliegen zuerst. */
const MAX_TILES = 4000;

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

let putsSinceTrim = 0;
/** Cache auf `max` Einträge kürzen (keys() liefert in Einfügereihenfolge: älteste zuerst). */
async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function cacheFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    if (cacheName === TILES && ++putsSinceTrim >= 50) {
      putsSinceTrim = 0;
      trim(TILES, MAX_TILES).catch(() => {});
    }
  }
  return res;
}

async function networkFirst(req, cacheName = SHELL) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(req)) ?? (cacheName === SHELL ? await cache.match('./') : undefined);
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
  } else if (url.origin === self.location.origin && url.pathname.includes('/peaks/')) {
    // Gipfelkacheln: eigener Cache, übersteht App-Updates (der Shell-Cache wird dann geleert)
    e.respondWith(networkFirst(req, PEAKS));
  } else if (url.origin === self.location.origin) {
    // Gehashte Assets ändern sich nie; HTML/Manifest immer frisch, offline aus Cache
    e.respondWith(url.pathname.includes('/assets/') ? cacheFirst(SHELL, req) : networkFirst(req));
  }
});
