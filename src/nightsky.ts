/**
 * Nachthimmel: Sterne (bis 5,5 mag), Sternbildlinien und -namen, Planeten in
 * Horizontkoordinaten für Zeit und Ort. Daten: public/sky/sky.json (scripts/build-sky.mjs).
 */
import { PLANETS, planetEquatorial, starPosition, starsToHorizontal, type PlanetId } from './astro';
import { MILKY_WAY_CORE } from './tracks';
import type { Lang } from './i18n';

type Names = Record<'en' | 'de' | 'fr' | 'it', string>;

export interface SkyData {
  stars: [number, number, number, number, Names?][];
  constellations: { id: string; names: Names & { la: string }; label: [number, number]; lines: [number, number][][] }[];
}

/** Antippbares Objekt (Planet, heller benannter Stern). */
export interface SkyObject {
  key: string;
  kind: 'planet' | 'star' | 'deep';
  name: string;
  az: number;
  alt: number;
  mag: number;
}

export interface NightSky {
  /** Je Stern Azimut, Höhe (paarweise), Helligkeit und Farbindex. */
  pos: Float32Array;
  mag: Float32Array;
  bv: Float32Array;
  /** Sternbildlinien als Strecken: az1, alt1, az2, alt2. */
  lines: Float32Array;
  labels: { text: string; az: number; alt: number }[];
  objects: SkyObject[];
  /** 0 = Tag, 1 = volle Nacht (aus der Sonnenhöhe). */
  fade: number;
  /** Grenzhelligkeit je nach Dämmerung. */
  magLimit: number;
}

/** Vorbereitete Daten: Koordinaten als Float32Array für die Massenumrechnung. */
export interface PreparedSky {
  data: SkyData;
  starRadec: Float32Array;
  mag: Float32Array;
  bv: Float32Array;
  lineRadec: Float32Array;
  labelRadec: Float32Array;
}

export function prepareSky(data: SkyData): PreparedSky {
  const starRadec = new Float32Array(data.stars.flatMap((s) => [s[0], s[1]]));
  const seg: number[] = [];
  for (const c of data.constellations) {
    for (const line of c.lines) {
      for (let k = 1; k < line.length; k++) seg.push(line[k - 1][0], line[k - 1][1], line[k][0], line[k][1]);
    }
  }
  const labelRadec = new Float32Array(data.constellations.flatMap((c) => c.label));
  return {
    data,
    starRadec,
    mag: new Float32Array(data.stars.map((s) => s[2])),
    bv: new Float32Array(data.stars.map((s) => s[3])),
    lineRadec: new Float32Array(seg),
    labelRadec,
  };
}

/** Dämmerung: Sterne ab Sonnenhöhe −4° einblenden, volle Nacht ab −14°. */
export function darkness(sunAlt: number): number {
  return Math.min(1, Math.max(0, (-sunAlt - 4) / 10));
}

export function buildNightSky(
  sky: PreparedSky,
  date: Date,
  lat: number,
  lon: number,
  lang: Lang,
  sunAlt: number,
  planetName: (id: PlanetId) => string,
  milkyWayName = 'Milky Way core',
): NightSky {
  const fade = darkness(sunAlt);
  const magLimit = 1 + 4.5 * fade;
  const { data } = sky;
  const pos = new Float32Array(sky.starRadec.length);
  starsToHorizontal(sky.starRadec, date, lat, lon, pos);
  const lines = new Float32Array(sky.lineRadec.length);
  starsToHorizontal(sky.lineRadec, date, lat, lon, lines);
  const labelPos = new Float32Array(sky.labelRadec.length);
  starsToHorizontal(sky.labelRadec, date, lat, lon, labelPos);
  const labels = data.constellations.map((c, i) => ({ text: c.names[lang], az: labelPos[2 * i], alt: labelPos[2 * i + 1] }));

  const objects: SkyObject[] = [];
  data.stars.forEach((s, i) => {
    if (s[4]) objects.push({ key: `star:${s[4].en}`, kind: 'star', name: s[4][lang], az: pos[2 * i], alt: pos[2 * i + 1], mag: s[2] });
  });
  for (const id of PLANETS) {
    const p = planetEquatorial(id, date);
    const h = starPosition(p.ra, p.dec, date, lat, lon);
    objects.push({ key: `planet:${id}`, kind: 'planet', name: planetName(id), az: h.az, alt: h.alt, mag: p.mag });
  }
  const mw = starPosition(MILKY_WAY_CORE.ra, MILKY_WAY_CORE.dec, date, lat, lon);
  objects.push({ key: 'mw', kind: 'deep', name: milkyWayName, az: mw.az, alt: mw.alt, mag: 2 });
  return {
    pos,
    mag: sky.mag,
    bv: sky.bv,
    lines,
    labels,
    objects,
    fade,
    magLimit,
  };
}
