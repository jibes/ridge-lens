import type { LatLon } from './geo';
import type { Lang } from './i18n';

export interface PeakRaw {
  id: number;
  name: string;
  names: Partial<Record<Lang, string>>;
  lat: number;
  lon: number;
  /** Höhe laut OSM, falls brauchbar angegeben. */
  ele: number | null;
}

// Öffentliche Overpass-Instanzen; bei Überlastung (429/504, ohne CORS → "Failed to fetch") nächste versuchen
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const CACHE_NAME = 'ridge-lens-peaks-v3';
const NAME_LANGS: Lang[] = ['de', 'en', 'fr', 'it'];
const TIMEOUT_MS = 30_000;

/** OSM-`ele` ist Freitext ("2'345", "1234 m", "1234;1236"); erste Zahl in Metern. */
export function parseEle(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.replace(/['’\s]/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let v = parseFloat(m[0]);
  if (/ft|feet|'$/.test(raw)) v *= 0.3048;
  return Number.isFinite(v) && v > -500 && v < 9000 ? v : null;
}

/** Overpass-CSV (Tab-getrennt): id, lat, lon, ele, name, name:de, name:en, name:fr, name:it. */
export function parseOverpassCsv(text: string): PeakRaw[] {
  const out: PeakRaw[] = [];
  for (const line of text.split('\n')) {
    const [id, lat, lon, ele, name, ...localized] = line.split('\t');
    if (!name || !lat || !lon) continue;
    const names: PeakRaw['names'] = {};
    NAME_LANGS.forEach((l, i) => {
      if (localized[i]) names[l] = localized[i];
    });
    out.push({ id: Number(id), name, names, lat: Number(lat), lon: Number(lon), ele: parseEle(ele) });
  }
  return out;
}

/** Rechteck (S, W, N, O) um den Kreis, nach außen auf 0.05° gerundet: stabiler Cache-Schlüssel. */
export function peakBBox(center: LatLon, radius: number): [number, number, number, number] {
  const dLat = (radius + 1500) / 111_195;
  const dLon = dLat / Math.cos((center.lat * Math.PI) / 180);
  const down = (v: number) => Math.floor(v * 20) / 20;
  const up = (v: number) => Math.ceil(v * 20) / 20;
  return [down(center.lat - dLat), down(center.lon - dLon), up(center.lat + dLat), up(center.lon + dLon)];
}

/** Zeile im mitgelieferten Datensatz: [id, lat, lon, ele|null, name, de, en, fr, it]. */
export type PeakRow = [number, number, number, number | null, string, string, string, string, string];

export function rowsToPeaks(rows: PeakRow[], [s, w, n, e]: [number, number, number, number]): PeakRaw[] {
  const out: PeakRaw[] = [];
  for (const [id, lat, lon, ele, name, ...localized] of rows) {
    if (lat < s || lat > n || lon < w || lon > e) continue;
    const names: PeakRaw['names'] = {};
    NAME_LANGS.forEach((l, i) => {
      if (localized[i]) names[l] = localized[i];
    });
    out.push({ id, name, names, lat, lon, ele });
  }
  return out;
}

interface DatasetIndex {
  region: { south: number; north: number; west: number; east: number };
  tiles: string[];
}

/**
 * Gipfel aus dem mit der App ausgelieferten Datensatz (1°-Kacheln, im CI aus OSM erzeugt).
 * Null, wenn kein Datensatz vorhanden oder das Rechteck nicht abgedeckt ist.
 */
async function fetchBundledPeaks(bbox: [number, number, number, number]): Promise<PeakRaw[] | null> {
  const base = new URL('../peaks/', import.meta.url);
  const res = await fetch(new URL('index.json', base)).catch(() => null);
  if (!res?.ok) return null;
  const index = (await res.json().catch(() => null)) as DatasetIndex | null;
  if (!index) return null;
  const [s, w, n, e] = bbox;
  const r = index.region;
  if (s < r.south || n > r.north || w < r.west || e > r.east) return null;
  const available = new Set(index.tiles);
  const keys: string[] = [];
  for (let lat = Math.floor(s); lat <= Math.floor(n); lat++) {
    for (let lon = Math.floor(w); lon <= Math.floor(e); lon++) {
      if (available.has(`${lat}_${lon}`)) keys.push(`${lat}_${lon}`);
    }
  }
  const tiles = await Promise.all(
    keys.map(async (k) => {
      const tr = await fetch(new URL(`${k}.json`, base));
      if (!tr.ok) throw new Error(`peaks/${k}.json HTTP ${tr.status}`);
      return (await tr.json()) as PeakRow[];
    }),
  ).catch(() => null);
  return tiles && rowsToPeaks(tiles.flat(), bbox);
}

/**
 * Benannte Gipfel im Rechteck um den Kreis: zuerst aus dem mitgelieferten Datensatz,
 * sonst live über Overpass (Rechteck ist dort deutlich billiger als `around`).
 */
export async function fetchPeaks(center: LatLon, radius: number): Promise<PeakRaw[]> {
  const box = peakBBox(center, radius);
  const bundled = await fetchBundledPeaks(box);
  if (bundled) return bundled;

  const bbox = box.map((v) => v.toFixed(2)).join(',');
  const query =
    `[out:csv(::id,::lat,::lon,ele,name,${NAME_LANGS.map((l) => `"name:${l}"`).join(',')};false;"\t")]` +
    `[timeout:60][bbox:${bbox}];` +
    `node["natural"="peak"]["name"];out qt;`;
  const qs = `?data=${encodeURIComponent(query)}`;

  const cache = await caches.open(CACHE_NAME).catch(() => null);
  const cacheKey = `https://ridge-lens.local/peaks?bbox=${bbox}`;
  const hit = await cache?.match(cacheKey);
  if (hit) return (await hit.json()) as PeakRaw[];

  const errors: string[] = [];
  for (const ep of ENDPOINTS) {
    try {
      const res = await fetch(ep + qs, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // Overpass meldet Laufzeitfehler mit Status 200 als HTML/Remark
      if (/<html|runtime error/i.test(text.slice(0, 500))) throw new Error('server error');
      const peaks = parseOverpassCsv(text);
      if (!peaks.length && text.trim() && !text.includes('\t')) throw new Error('bad response');
      await cache
        ?.put(cacheKey, new Response(JSON.stringify(peaks), { headers: { 'Content-Type': 'application/json' } }))
        .catch(() => {});
      return peaks;
    } catch (e) {
      const msg = e instanceof Error ? (e.name === 'TimeoutError' ? 'timeout' : e.message) : String(e);
      errors.push(`${new URL(ep).hostname}: ${msg}`);
    }
  }
  throw new Error(errors.join('; '));
}
