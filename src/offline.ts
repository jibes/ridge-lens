/**
 * Umkreis offline speichern: Höhen- und Gipfelkacheln im Sichtradius vorab in die Caches
 * des Service Workers legen (Namen wie in public/sw.js), damit die App am Berg ohne Netz
 * rechnet. Bereits gespeicherte Kacheln werden übersprungen.
 */
import { FAR_ZOOM, NEAR_RADIUS, NEAR_ZOOM, TERRARIUM_URL, tilesCovering } from './dem';
import type { LatLon } from './geo';
import { tilesFor } from './peaks';

const TILES = 'ridge-lens-tiles-v1';
const PEAKS = 'ridge-lens-peaks-data-v1';

export interface OfflineProgress {
  done: number;
  total: number;
  failed: number;
  bytes: number;
}

export async function prefetchArea(center: LatLon, radius: number, onProgress: (p: OfflineProgress) => void): Promise<OfflineProgress> {
  const urls: { url: string; cache: string }[] = [];
  for (const [z, r] of [
    [NEAR_ZOOM, NEAR_RADIUS],
    [FAR_ZOOM, radius],
  ] as const) {
    for (const [x, y] of tilesCovering(center, r, z)) urls.push({ url: `${TERRARIUM_URL}/${z}/${x}/${y}.png`, cache: TILES });
  }
  // Gipfel: Index, dann nur Kacheln, die es gibt
  // Pfad als Variable: ein Literal in new URL(…, import.meta.url) schreibt Vite um
  const dir = '../peaks/';
  const peaksBase = new URL(dir, import.meta.url);
  const indexUrl = new URL('index.json', peaksBase).href;
  urls.push({ url: indexUrl, cache: PEAKS });
  // Satelliten-Bahnelemente (einige Tage brauchbar)
  urls.push({ url: new URL('sats.json', peaksBase).href, cache: PEAKS });
  const index = (await fetch(indexUrl)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as { tiles?: string[] } | null;
  const have = new Set(index?.tiles ?? []);
  for (const { lat, lon } of tilesFor(center, radius)) {
    const key = `${lat}_${lon}`;
    if (have.has(key)) urls.push({ url: new URL(`${key}.json`, peaksBase).href, cache: PEAKS });
  }

  const progress: OfflineProgress = { done: 0, total: urls.length, failed: 0, bytes: 0 };
  onProgress(progress);
  const caches_ = new Map<string, Cache>();
  const open = async (name: string) => caches_.get(name) ?? caches_.set(name, await caches.open(name)).get(name)!;
  const queue = urls.slice();
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        const cache = await open(job.cache);
        // Index und Bahnelemente immer frisch, Kacheln nur, wenn noch nicht gespeichert
        const fresh = job.url === indexUrl || job.url.endsWith('/sats.json');
        const hit = fresh ? undefined : await cache.match(job.url);
        if (hit) {
          progress.bytes += Number(hit.headers.get('content-length')) || 0;
        } else {
          const res = await fetch(job.url);
          if (!res.ok) throw new Error(String(res.status));
          const blob = await res.clone().blob();
          progress.bytes += blob.size;
          await cache.put(job.url, res);
        }
      } catch {
        progress.failed++;
      }
      progress.done++;
      onProgress(progress);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return progress;
}
