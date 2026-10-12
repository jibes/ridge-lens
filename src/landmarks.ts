import type { LatLon } from './geo';
import { tilesFor } from './peaks';

/**
 * Türme als Fixpunkte für den Kursabgleich: Sendetürme, Aussichts- und Kirchtürme, hohe
 * Masten und Kamine aus OSM. Im Bild ragen sie als dünne Spitzen über den Horizont; ein
 * einzelner legt den Kurs auch vor einem flachen Grat fest.
 */

/** c Sendeturm, o Aussichtsturm, b Kirch-/Glockenturm, Minarett, m Mast, h Kamin, w sonstiger hoher Turm. */
export type LandmarkKind = 'c' | 'o' | 'b' | 'm' | 'h' | 'w';

export interface LandmarkRaw {
  lat: number;
  lon: number;
  /** Höhe über Grund (m) laut OSM, sonst null. */
  height: number | null;
  kind: LandmarkKind;
  name: string;
}

/** Zeile im mitgelieferten Datensatz (peaks/lm/<lat>_<lon>.json): [lat, lon, height|null, kind, name]. */
export type LandmarkRow = [number, number, number | null, LandmarkKind, string];

/** Übliche Höhe je Art, falls OSM keine angibt (nur für die Plausibilität der Spitze im Bild). */
export const DEFAULT_HEIGHT: Record<LandmarkKind, number> = { c: 80, o: 30, b: 40, m: 60, h: 80, w: 35 };

/** OSM-`height` ("45", "45 m", "150 ft") in Metern. */
export function parseHeight(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.replace(',', '.').match(/\d+(\.\d+)?/);
  if (!m) return null;
  let v = parseFloat(m[0]);
  if (/ft|feet|'/.test(raw)) v *= 0.3048;
  return v > 2 && v < 700 ? Math.round(v) : null;
}

/**
 * Welche Türme taugen: im Bild sichtbar hoch und eindeutig. Gleiche Regeln im Build-Skript
 * (scripts/build-peaks.mjs) – bei Änderungen beide anpassen.
 */
export function classifyLandmark(tags: Record<string, string | undefined>): { kind: LandmarkKind; height: number | null } | null {
  const height = parseHeight(tags.height);
  const type = tags['tower:type'] ?? '';
  switch (tags.man_made) {
    case 'communications_tower':
      return { kind: 'c', height };
    case 'tower':
      if (type === 'communication') return { kind: 'c', height };
      if (type === 'observation' || type === 'lookout') return { kind: 'o', height };
      if (type === 'bell_tower' || type === 'minaret') return { kind: 'b', height };
      return height !== null && height >= 25 ? { kind: 'w', height } : null;
    case 'mast':
      return height !== null && height >= 40 ? { kind: 'm', height } : null;
    case 'chimney':
      return height !== null && height >= 50 ? { kind: 'h', height } : null;
    default:
      return null;
  }
}

export function rowsToLandmarks(rows: LandmarkRow[]): LandmarkRaw[] {
  return rows.map(([lat, lon, height, kind, name]) => ({ lat, lon, height, kind, name }));
}

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const CACHE_NAME = 'ridge-lens-landmarks-v1';
const TILE_MAX_AGE_MS = 30 * 86_400_000;

/** Eine 1°-Kachel live von Overpass (Wege/Flächen über ihren Mittelpunkt). */
async function fetchOverpassTile(lat: number, lon: number): Promise<LandmarkRaw[]> {
  const bbox = `${lat},${lon},${lat + 1},${lon + 1}`;
  const query =
    `[out:json][timeout:60][bbox:${bbox}];(` +
    `nwr["man_made"="communications_tower"];` +
    `nwr["man_made"="tower"]["tower:type"~"^(communication|observation|lookout|bell_tower|minaret)$"];` +
    `nwr["man_made"="tower"]["height"];nwr["man_made"~"^(mast|chimney)$"]["height"];);out center tags qt;`;
  const errors: string[] = [];
  for (const ep of ENDPOINTS) {
    try {
      const res = await fetch(`${ep}?data=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { elements: { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[] };
      const out: LandmarkRaw[] = [];
      for (const e of body.elements) {
        const p = e.center ?? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : null);
        const c = e.tags && classifyLandmark(e.tags);
        if (p && c && p.lat < lat + 1 && p.lon < lon + 1) out.push({ ...p, ...c, name: e.tags?.name ?? '' });
      }
      return out;
    } catch (e) {
      errors.push(`${new URL(ep).hostname}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(errors.join('; '));
}

/**
 * Türme im Umkreis: mitgelieferter Datensatz (peaks/lm/), sonst Browser-Cache (30 Tage),
 * sonst Overpass. Fehler einzelner Kacheln werden übergangen (Türme sind nur eine Hilfe).
 */
export async function loadLandmarks(center: LatLon, radius: number): Promise<LandmarkRaw[]> {
  // Pfad als Variable: ein Literal in new URL(…, import.meta.url) schreibt Vite um
  const dir = '../peaks/lm/';
  const base = new URL(dir, import.meta.url);
  const index = (await fetch(new URL('index.json', base))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as { tiles: string[] } | null;
  const tiles = new Set(index?.tiles ?? []);
  const cache = await caches.open(CACHE_NAME).catch(() => null);
  const out: LandmarkRaw[] = [];
  for (const { lat, lon } of tilesFor(center, radius)) {
    const key = `${lat}_${lon}`;
    if (index) {
      if (!tiles.has(key)) continue;
      const rows = (await fetch(new URL(`${key}.json`, base))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)) as LandmarkRow[] | null;
      if (rows) out.push(...rowsToLandmarks(rows));
      continue;
    }
    const cacheKey = `https://ridge-lens.local/landmark-tile/${key}`;
    const hit = (await cache?.match(cacheKey)?.then((r) => r?.json()).catch(() => null)) as { t: number; list: LandmarkRaw[] } | null | undefined;
    if (hit && Date.now() - hit.t < TILE_MAX_AGE_MS) {
      out.push(...hit.list);
      continue;
    }
    try {
      const list = await fetchOverpassTile(lat, lon);
      await cache?.put(cacheKey, new Response(JSON.stringify({ t: Date.now(), list }), { headers: { 'Content-Type': 'application/json' } })).catch(() => {});
      out.push(...list);
    } catch {
      /* Overpass nicht erreichbar: ohne Türme */
    }
  }
  return out;
}
