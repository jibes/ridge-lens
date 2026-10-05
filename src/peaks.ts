import type { LatLon } from './geo';

export interface PeakRaw {
  id: number;
  name: string;
  lat: number;
  lon: number;
  /** Höhe laut OSM, falls brauchbar angegeben. */
  ele: number | null;
}

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const CACHE_NAME = 'ridge-lens-peaks-v1';

/** OSM-`ele` ist Freitext ("2'345", "1234 m", "1234;1236"); erste Zahl in Metern. */
export function parseEle(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = raw.replace(/['’\s]/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let v = parseFloat(m[0]);
  if (/ft|feet|'$/.test(raw)) v *= 0.3048;
  return Number.isFinite(v) && v > -500 && v < 9000 ? v : null;
}

interface OverpassNode {
  type: string;
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export function parseOverpass(json: { elements: OverpassNode[] }): PeakRaw[] {
  const out: PeakRaw[] = [];
  for (const el of json.elements) {
    const name = el.tags?.['name:de'] ?? el.tags?.name;
    if (el.type !== 'node' || !name) continue;
    out.push({ id: el.id, name, lat: el.lat, lon: el.lon, ele: parseEle(el.tags?.ele) });
  }
  return out;
}

/** Gipfel im Umkreis; Anfrage auf 0.01° gerundet, damit der Browser-Cache greift. */
export async function fetchPeaks(center: LatLon, radius: number): Promise<PeakRaw[]> {
  const lat = center.lat.toFixed(2);
  const lon = center.lon.toFixed(2);
  const r = Math.ceil(radius + 1500);
  const query = `[out:json][timeout:90];node["natural"="peak"]["name"](around:${r},${lat},${lon});out body;`;
  const qs = `?data=${encodeURIComponent(query)}`;

  const cache = await caches.open(CACHE_NAME).catch(() => null);
  const cacheKey = ENDPOINTS[0] + qs;
  const hit = await cache?.match(cacheKey);
  if (hit) return parseOverpass(await hit.json());

  let lastErr: unknown;
  for (const ep of ENDPOINTS) {
    try {
      const res = await fetch(ep + qs);
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      await cache?.put(cacheKey, res.clone()).catch(() => {});
      return parseOverpass(await res.json());
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
