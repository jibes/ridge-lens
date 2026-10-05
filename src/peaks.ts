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

/** Benannte Gipfel im Rechteck um den Kreis (Rechteck ist für Overpass deutlich billiger als `around`). */
export async function fetchPeaks(center: LatLon, radius: number): Promise<PeakRaw[]> {
  const bbox = peakBBox(center, radius)
    .map((v) => v.toFixed(2))
    .join(',');
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
