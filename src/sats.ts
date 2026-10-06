/**
 * Satelliten (ISS, chinesische Station, Hubble und die hellsten weiteren) aus
 * tagesaktuellen Bahnelementen (CelesTrak, vom Workflow nach peaks/sats.json gelegt):
 * Richtung, Sonnenlicht, nächster Überflug. Mit bloßem Auge sichtbar ist ein Satellit,
 * wenn er von der Sonne beschienen wird und es beim Beobachter dunkel ist.
 */
import { eciToEcf, ecfToLookAngles, gstime, propagate, twoline2satrec, type SatRec } from 'satellite.js';
import { julianDate, sunEcliptic, sunPosition, type PathPoint } from './astro';

export interface SatInfo {
  key: string;
  name: string;
  rec: SatRec;
  /** Bekannte Raumstation/-teleskop: immer beschriftet. */
  major: boolean;
}

export interface SatLook {
  az: number;
  alt: number;
  /** Von der Sonne beschienen (nicht im Erdschatten). */
  sunlit: boolean;
}

export interface SatPass {
  rise: number;
  set: number;
  maxAlt: number;
  /** Mit bloßem Auge: beschienen, während beim Beobachter die Sonne ≥ 6° unter dem Horizont steht. */
  visible: boolean;
  path: PathPoint[];
}

const MAJOR: Record<string, string> = { '25544': 'ISS', '48274': 'Tiangong', '20580': 'Hubble' };
const RAD = Math.PI / 180;
const EARTH_R = 6371;

/** sats.json: { generated, sats: [{ n: Name, l1, l2 }] }. */
export function parseSats(json: { sats: { n: string; l1: string; l2: string }[] }): SatInfo[] {
  const out: SatInfo[] = [];
  for (const s of json.sats) {
    const id = s.l1.slice(2, 7).trim();
    try {
      const rec = twoline2satrec(s.l1, s.l2);
      out.push({ key: `sat:${id}`, name: MAJOR[id] ?? titleCase(s.n), rec, major: id in MAJOR });
    } catch {
      /* fehlerhafter Datensatz */
    }
  }
  return out;
}

function titleCase(s: string): string {
  return s.trim().replace(/\S+/g, (w) => (/\d/.test(w) || w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase()));
}

/** Sonnenrichtung (Einheitsvektor, äquatorial) für den Erdschatten. */
function sunVector(date: Date): [number, number, number] {
  const { lon, obliquity } = sunEcliptic(julianDate(date));
  const l = lon * RAD;
  const e = obliquity * RAD;
  return [Math.cos(l), Math.cos(e) * Math.sin(l), Math.sin(e) * Math.sin(l)];
}

/** Richtung vom Beobachter (lat/lon Grad, Höhe m) und Sonnenlicht; null, wenn die Bahn nicht rechenbar ist. */
export function satLook(sat: SatInfo, date: Date, lat: number, lon: number, heightM: number): SatLook | null {
  const pv = propagate(sat.rec, date);
  if (!pv || typeof pv.position !== 'object') return null;
  const pos = pv.position;
  const gmst = gstime(date);
  const la = ecfToLookAngles({ latitude: lat * RAD, longitude: lon * RAD, height: heightM / 1000 }, eciToEcf(pos, gmst));
  // Zylindrischer Erdschatten
  const s = sunVector(date);
  const along = pos.x * s[0] + pos.y * s[1] + pos.z * s[2];
  const perp = Math.hypot(pos.x - along * s[0], pos.y - along * s[1], pos.z - along * s[2]);
  return { az: (((la.azimuth / RAD) % 360) + 360) % 360, alt: la.elevation / RAD, sunlit: along > 0 || perp > EARTH_R };
}

/**
 * Laufender oder nächster Überflug innerhalb von `horizonH` Stunden (Höhe > 0°), Bahn in
 * 10-s-Schritten. null, wenn keiner.
 */
export function nextPass(sat: SatInfo, from: number, lat: number, lon: number, heightM: number, horizonH = 24): SatPass | null {
  const look = (t: number) => satLook(sat, new Date(t), lat, lon, heightM);
  let t = from;
  const end = from + horizonH * 3_600_000;
  // Läuft gerade ein Überflug: zurück bis zum Aufgang
  let l = look(t);
  if (l && l.alt > 0) {
    while (l && l.alt > 0 && t > from - 30 * 60_000) {
      t -= 10_000;
      l = look(t);
    }
  } else {
    // Grob in 30-s-Schritten bis über den Horizont, dann fein
    while (t < end && !((l = look(t)) && l.alt > 0)) t += 30_000;
    if (t >= end) return null;
    t -= 30_000;
  }
  const path: PathPoint[] = [];
  let visible = false;
  let maxAlt = -90;
  let rise = 0;
  for (let k = 0; k < 2000; k++, t += 10_000) {
    const p = look(t);
    if (!p) break;
    if (p.alt <= 0) {
      if (rise) break;
      continue;
    }
    if (!rise) rise = t;
    path.push({ t, az: p.az, alt: p.alt });
    maxAlt = Math.max(maxAlt, p.alt);
    if (p.sunlit && sunPosition(new Date(t), lat, lon).alt < -6) visible = true;
  }
  return rise ? { rise, set: path[path.length - 1].t, maxAlt, visible, path } : null;
}
