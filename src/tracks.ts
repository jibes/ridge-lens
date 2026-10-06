/**
 * Tagesbahnen für einzelne Himmelskörper (Planeten, Sterne, Sternbilder, Zentrum der
 * Milchstraße): Richtung je Zeitschritt über dem mathematischen Horizont.
 */
import { planetEquatorial, starPosition, type PathPoint, type PlanetId } from './astro';
import type { SkyData } from './nightsky';

/** Zentrum der Milchstraße (Sgr A*), J2000. */
export const MILKY_WAY_CORE = { ra: 266.417, dec: -29.008 };

/** J2000-Koordinaten zum Schlüssel ('planet:mars', 'star:Sirius', 'con:Ori', 'mw'); null = unbekannt. */
export function objectRadec(key: string, data: SkyData | null, date: Date): { ra: number; dec: number } | null {
  if (key === 'mw') return MILKY_WAY_CORE;
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'planet') return planetEquatorial(id as PlanetId, date);
  if (!data) return null;
  if (kind === 'star') {
    const s = data.stars.find((x) => x[4]?.en === id);
    return s ? { ra: s[0], dec: s[1] } : null;
  }
  if (kind === 'con') {
    const c = data.constellations.find((x) => x.id === id);
    return c ? { ra: c.label[0], dec: c.label[1] } : null;
  }
  return null;
}

/** Bahn von `start` bis `end` (ms) in Schritten von `stepMin` Minuten; leer, wenn unbekannt. */
export function dayTrack(key: string, data: SkyData | null, lat: number, lon: number, start: number, end: number, stepMin = 10): PathPoint[] {
  const out: PathPoint[] = [];
  for (let t = start; t <= end; t += stepMin * 60_000) {
    const date = new Date(t);
    const rd = objectRadec(key, data, date);
    if (!rd) return [];
    const p = starPosition(rd.ra, rd.dec, date, lat, lon);
    out.push({ t, az: p.az, alt: p.alt });
  }
  return out;
}
