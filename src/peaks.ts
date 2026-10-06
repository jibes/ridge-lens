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
  /** Bekanntheit: Zahl der Wikipedia-Sprachversionen (Datensatz) bzw. 1 bei Wikidata-Verweis (live), sonst 0. */
  fame: number;
}

// Öffentliche Overpass-Instanzen; bei Überlastung (429/504, ohne CORS → "Failed to fetch") nächste versuchen
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const CACHE_NAME = 'ridge-lens-peaks-v6';
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

/** Overpass-CSV (Tab-getrennt): id, lat, lon, ele, name, name:de, name:en, name:fr, name:it, wikidata. */
export function parseOverpassCsv(text: string): PeakRaw[] {
  const out: PeakRaw[] = [];
  for (const line of text.split('\n')) {
    const [id, lat, lon, ele, name, ...rest] = line.split('\t');
    if (!name || !lat || !lon) continue;
    const names: PeakRaw['names'] = {};
    NAME_LANGS.forEach((l, i) => {
      if (rest[i]) names[l] = rest[i];
    });
    const fame = rest[NAME_LANGS.length]?.trim() ? 1 : 0;
    out.push({ id: Number(id), name, names, lat: Number(lat), lon: Number(lon), ele: parseEle(ele), fame });
  }
  return out;
}

/** Zeile im mitgelieferten Datensatz: [id, lat, lon, ele|null, name, de, en, fr, it, fame, wikidata] (fame/wikidata optional). */
export type PeakRow = [number, number, number, number | null, string, string, string, string, string, number?, string?];

export function rowsToPeaks(rows: PeakRow[]): PeakRaw[] {
  return rows.map(([id, lat, lon, ele, name, de, en, fr, it, fame]) => {
    const names: PeakRaw['names'] = {};
    [de, en, fr, it].forEach((n, i) => {
      if (n) names[NAME_LANGS[i]] = n;
    });
    return { id, name, names, lat, lon, ele, fame: fame ?? 0 };
  });
}

const RAD = Math.PI / 180;

/** Kürzeste Distanz (m) vom Punkt zum 1°-Feld [lat, lat+1) × [lon, lon+1), flach genähert. */
function distanceToTile(c: LatLon, lat: number, lon: number): number {
  const dy = Math.max(lat - c.lat, 0, c.lat - (lat + 1)) * 111_195;
  const dx = Math.max(lon - c.lon, 0, c.lon - (lon + 1)) * 111_195 * Math.cos(c.lat * RAD);
  return Math.hypot(dx, dy);
}

/** 1°-Kacheln im Umkreis, sortiert nach Entfernung (eigene Kachel zuerst). */
export function tilesFor(center: LatLon, radius: number): { lat: number; lon: number; dist: number }[] {
  const dLat = radius / 111_195;
  const dLon = dLat / Math.cos(center.lat * RAD);
  const out: { lat: number; lon: number; dist: number }[] = [];
  for (let lat = Math.floor(center.lat - dLat); lat <= Math.floor(center.lat + dLat); lat++) {
    for (let lon = Math.floor(center.lon - dLon); lon <= Math.floor(center.lon + dLon); lon++) {
      const dist = distanceToTile(center, lat, lon);
      if (dist <= radius) out.push({ lat, lon, dist });
    }
  }
  return out.sort((a, b) => a.dist - b.dist);
}

interface DatasetIndex {
  /** "global": alle Kacheln weltweit enthalten (fehlende = keine Gipfel). */
  coverage?: 'global';
  /** Ältere, regionale Datensätze: Gebiet und fertig geladene Blöcke "süd_west". */
  region?: { south: number; north: number; west: number; east: number };
  blockSize?: number;
  blocks?: string[];
  /** Kacheln mit Gipfeln. */
  tiles: string[];
}

export interface PeakTile {
  key: string;
  peaks: PeakRaw[];
  source: 'bundled' | 'cache' | 'overpass';
  /** Technische Fehlerdetails, falls die Kachel nicht geladen werden konnte (peaks leer). */
  error?: string;
}

const TILE_MAX_AGE_MS = 30 * 86_400_000;
const OVERPASS_PAUSE_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mitgelieferter Datensatz: Index einmal laden; null wenn nicht vorhanden. */
async function loadIndex(base: URL): Promise<DatasetIndex | null> {
  const res = await fetch(new URL('index.json', base)).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as DatasetIndex | null;
}

/** Ob die Kachel im mitgelieferten Datensatz vollständig vorliegt. */
function bundledCovers(index: DatasetIndex | null, lat: number, lon: number): boolean {
  if (!index) return false;
  if (index.coverage === 'global') return true;
  const r = index.region;
  if (!r || !index.blockSize || !index.blocks) return false;
  if (lat < r.south || lat >= r.north || lon < r.west || lon >= r.east) return false;
  const B = index.blockSize;
  const bs = r.south + Math.floor((lat - r.south) / B) * B;
  const bw = r.west + Math.floor((lon - r.west) / B) * B;
  return index.blocks.includes(`${bs}_${bw}`);
}

/** Eine 1°-Kachel live von Overpass; Punkte auf der Nord-/Ostkante gehören zur Nachbarkachel. */
async function fetchOverpassTile(lat: number, lon: number): Promise<PeakRaw[]> {
  const query =
    `[out:csv(::id,::lat,::lon,ele,name,${NAME_LANGS.map((l) => `"name:${l}"`).join(',')},wikidata;false;"\t")]` +
    `[timeout:60][bbox:${lat},${lon},${lat + 1},${lon + 1}];` +
    `node["natural"~"^(peak|volcano)$"]["name"];out qt;`;
  const qs = `?data=${encodeURIComponent(query)}`;
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
      return peaks.filter((p) => p.lat < lat + 1 && p.lon < lon + 1);
    } catch (e) {
      const msg = e instanceof Error ? (e.name === 'TimeoutError' ? 'timeout' : e.message) : String(e);
      errors.push(`${new URL(ep).hostname}: ${msg}`);
    }
  }
  throw new Error(errors.join('; '));
}

/**
 * Gipfel kachelweise nach Entfernung: je Kachel aus dem mitgelieferten Datensatz,
 * sonst aus dem Browser-Cache (30 Tage), sonst live von Overpass – nacheinander mit
 * Pause, damit Overpass nicht drosselt. Eine gescheiterte Kachel wird mit `error`
 * geliefert und beim nächsten Mal erneut versucht.
 */
export async function* loadPeakTiles(center: LatLon, radius: number): AsyncGenerator<PeakTile, void> {
  // Pfad als Variable: ein Literal in new URL(…, import.meta.url) schreibt Vite um (im Dev-Server ohne Schrägstrich)
  const dir = '../peaks/';
  const base = new URL(dir, import.meta.url);
  const index = await loadIndex(base);
  const tileSet = new Set(index?.tiles ?? []);
  const cache = await caches.open(CACHE_NAME).catch(() => null);
  let lastNetwork = 0;
  for (const { lat, lon } of tilesFor(center, radius)) {
    const key = `${lat}_${lon}`;
    if (bundledCovers(index, lat, lon)) {
      // Leere Kacheln (Meer, Flachland) stehen nicht im Index
      if (!tileSet.has(key)) {
        yield { key, peaks: [], source: 'bundled' };
        continue;
      }
      const res = await fetch(new URL(`${key}.json`, base)).catch(() => null);
      if (res?.ok) {
        yield { key, peaks: rowsToPeaks((await res.json()) as PeakRow[]), source: 'bundled' };
        continue;
      }
    }
    const cacheKey = `https://ridge-lens.local/peak-tile/${key}`;
    const hit = (await cache?.match(cacheKey)?.then((r) => r?.json()).catch(() => null)) as
      | { t: number; peaks: PeakRaw[] }
      | null
      | undefined;
    if (hit && Date.now() - hit.t < TILE_MAX_AGE_MS) {
      yield { key, peaks: hit.peaks, source: 'cache' };
      continue;
    }
    const wait = lastNetwork + OVERPASS_PAUSE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const peaks = await fetchOverpassTile(lat, lon);
      lastNetwork = Date.now();
      await cache
        ?.put(cacheKey, new Response(JSON.stringify({ t: Date.now(), peaks }), { headers: { 'Content-Type': 'application/json' } }))
        .catch(() => {});
      yield { key, peaks, source: 'overpass' };
    } catch (e) {
      lastNetwork = Date.now();
      yield { key, peaks: [], source: 'overpass', error: e instanceof Error ? e.message : String(e) };
    }
  }
}
