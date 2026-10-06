/**
 * Sonne und Mond: scheinbare Position am Standort (Azimut ab Nord im Uhrzeigersinn,
 * Höhe mit Refraktion), Mondphase, Tagesbahnen und Auf-/Untergang über dem Gelände.
 * Niedrige Genauigkeit nach Meeus (Astronomical Algorithms, Kap. 25 und 47):
 * Sonne ≈ 0,01°, Mond ≈ 0,1° – weit unter der Sensorgenauigkeit.
 */

const RAD = Math.PI / 180;
const EARTH_RADIUS_KM = 6378.14;
const AU_KM = 149_597_870.7;

const sin = (deg: number) => Math.sin(deg * RAD);
const cos = (deg: number) => Math.cos(deg * RAD);
const norm = (deg: number) => ((deg % 360) + 360) % 360;

export interface SkyPosition {
  /** Azimut (Grad, 0 = Nord, 90 = Ost). */
  az: number;
  /** Scheinbare Höhe über dem mathematischen Horizont (Grad, mit Refraktion). */
  alt: number;
}

export interface MoonPosition extends SkyPosition {
  /** Beleuchteter Anteil der Scheibe (0 = Neumond, 1 = Vollmond). */
  fraction: number;
  /** Zunehmend (Lichtseite rechts auf der Nordhalbkugel). */
  waxing: boolean;
  /** Entfernung (km). */
  dist: number;
}

/** Julianisches Datum. */
export function julianDate(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

/** Ekliptikale Länge (Grad), Entfernung (km) und Schiefe der Ekliptik der Sonne. */
export function sunEcliptic(jd: number): { lon: number; dist: number; obliquity: number } {
  const T = (jd - 2_451_545) / 36_525;
  const L0 = 280.46646 + 36_000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35_999.05029 * T - 0.0001537 * T * T;
  const e = 0.016708634 - 0.000042037 * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(M) + (0.019993 - 0.000101 * T) * sin(2 * M) + 0.000289 * sin(3 * M);
  const omega = 125.04 - 1934.136 * T;
  const lon = L0 + C - 0.00569 - 0.00478 * sin(omega);
  const dist = ((1.000001018 * (1 - e * e)) / (1 + e * cos(M + C))) * AU_KM;
  const obliquity = 23.439291 - 0.0130042 * T + 0.00256 * cos(omega);
  return { lon: norm(lon), dist, obliquity };
}

/** Ekliptikale Länge/Breite (Grad) und Entfernung (km) des Mondes, Hauptterme. */
export function moonEcliptic(jd: number): { lon: number; lat: number; dist: number } {
  const T = (jd - 2_451_545) / 36_525;
  const Lp = 218.3164477 + 481_267.88123421 * T;
  const D = 297.8501921 + 445_267.1114034 * T;
  const M = 357.5291092 + 35_999.0502909 * T;
  const Mp = 134.9633964 + 477_198.8675055 * T;
  const F = 93.272095 + 483_202.0175233 * T;
  const lon =
    Lp +
    6.288774 * sin(Mp) +
    1.274027 * sin(2 * D - Mp) +
    0.658314 * sin(2 * D) +
    0.213618 * sin(2 * Mp) -
    0.185116 * sin(M) -
    0.114332 * sin(2 * F) +
    0.058793 * sin(2 * D - 2 * Mp) +
    0.057066 * sin(2 * D - M - Mp) +
    0.053322 * sin(2 * D + Mp) +
    0.045758 * sin(2 * D - M) -
    0.040923 * sin(M - Mp) -
    0.03472 * sin(D) -
    0.030383 * sin(M + Mp) +
    0.015327 * sin(2 * D - 2 * F) -
    0.012528 * sin(Mp + 2 * F) +
    0.01098 * sin(Mp - 2 * F) +
    0.010675 * sin(4 * D - Mp) +
    0.010034 * sin(3 * Mp) +
    0.008548 * sin(4 * D - 2 * Mp);
  const lat =
    5.128122 * sin(F) +
    0.280602 * sin(Mp + F) +
    0.277693 * sin(Mp - F) +
    0.173237 * sin(2 * D - F) +
    0.055413 * sin(2 * D - Mp + F) +
    0.046271 * sin(2 * D - Mp - F) +
    0.032573 * sin(2 * D + F) +
    0.017198 * sin(2 * Mp + F) +
    0.009266 * sin(2 * D + Mp - F) +
    0.008822 * sin(2 * Mp - F);
  const dist =
    385_000.56 -
    20_905.355 * cos(Mp) -
    3699.111 * cos(2 * D - Mp) -
    2955.968 * cos(2 * D) -
    569.925 * cos(2 * Mp) +
    48.888 * cos(M) -
    3.149 * cos(2 * F) +
    246.158 * cos(2 * D - 2 * Mp) -
    152.138 * cos(2 * D - M - Mp) -
    170.733 * cos(2 * D + Mp) -
    204.586 * cos(2 * D - M) -
    129.62 * cos(M - Mp) +
    108.743 * cos(D) +
    104.755 * cos(M + Mp);
  return { lon: norm(lon), lat, dist };
}

/** Ekliptikal → äquatorial (Rektaszension, Deklination in Grad). */
export function toEquatorial(lon: number, lat: number, obliquity: number): { ra: number; dec: number } {
  const ra = Math.atan2(sin(lon) * cos(obliquity) - Math.tan(lat * RAD) * sin(obliquity), cos(lon)) / RAD;
  const dec = Math.asin(sin(lat) * cos(obliquity) + cos(lat) * sin(obliquity) * sin(lon)) / RAD;
  return { ra: norm(ra), dec };
}

/** Mittlere Sternzeit Greenwich (Grad). */
function gmst(jd: number): number {
  const d = jd - 2_451_545;
  const T = d / 36_525;
  return norm(280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - (T * T * T) / 38_710_000);
}

/** Wahre Höhe/Azimut aus RA/Dec für einen Standort. */
function toHorizontal(ra: number, dec: number, jd: number, lat: number, lon: number): SkyPosition {
  const H = gmst(jd) + lon - ra;
  const alt = Math.asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(H)) / RAD;
  const az = Math.atan2(-cos(dec) * sin(H), sin(dec) * cos(lat) - cos(dec) * sin(lat) * cos(H)) / RAD;
  return { az: norm(az), alt };
}

/** Atmosphärische Refraktion (Grad) für eine wahre Höhe (Sæmundsson). */
export function refraction(trueAlt: number): number {
  if (trueAlt < -2) return 0;
  const h = Math.max(trueAlt, -1.9);
  return 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * RAD) / 60;
}

export function sunPosition(date: Date, lat: number, lon: number): SkyPosition {
  const jd = julianDate(date);
  const s = sunEcliptic(jd);
  const { ra, dec } = toEquatorial(s.lon, 0, s.obliquity);
  const p = toHorizontal(ra, dec, jd, lat, lon);
  return { az: p.az, alt: p.alt + refraction(p.alt) };
}

export function moonPosition(date: Date, lat: number, lon: number): MoonPosition {
  const jd = julianDate(date);
  const m = moonEcliptic(jd);
  const s = sunEcliptic(jd);
  const { ra, dec } = toEquatorial(m.lon, m.lat, s.obliquity);
  const geo = toHorizontal(ra, dec, jd, lat, lon);
  // Parallaxe: vom Erdmittelpunkt zum Standort liegt der Mond bis ~1° tiefer
  const parallax = Math.asin(EARTH_RADIUS_KM / m.dist) / RAD;
  const alt = geo.alt - parallax * cos(geo.alt);
  // Phase aus der Elongation zwischen Mond und Sonne
  const elong = Math.acos(cos(m.lat) * cos(m.lon - s.lon));
  const phaseAngle = Math.atan2(s.dist * Math.sin(elong), m.dist - s.dist * Math.cos(elong));
  return {
    az: geo.az,
    alt: alt + refraction(alt),
    fraction: (1 + Math.cos(phaseAngle)) / 2,
    waxing: norm(m.lon - s.lon) < 180,
    dist: m.dist,
  };
}

export interface PathPoint extends SkyPosition {
  t: number;
}

/** Bahn über einen Zeitraum (ms), Schritt in Minuten. */
export function bodyPath(
  position: (d: Date, lat: number, lon: number) => SkyPosition,
  lat: number,
  lon: number,
  start: number,
  end: number,
  stepMin: number,
): PathPoint[] {
  const out: PathPoint[] = [];
  for (let t = start; t <= end; t += stepMin * 60_000) {
    const p = position(new Date(t), lat, lon);
    out.push({ t, az: p.az, alt: p.alt });
  }
  return out;
}

/**
 * Erster Aufgang und letzter Untergang über dem Gelände innerhalb der Bahn
 * (`horizonAt(az)` = Höhenwinkel der Silhouette). Zeitpunkte linear interpoliert.
 */
export function terrainEvents(path: PathPoint[], horizonAt: (az: number) => number): { rise: number | null; set: number | null } {
  let rise: number | null = null;
  let set: number | null = null;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const da = a.alt - horizonAt(a.az);
    const db = b.alt - horizonAt(b.az);
    if ((da < 0) === (db < 0)) continue;
    const t = a.t + ((b.t - a.t) * da) / (da - db);
    if (da < 0) rise ??= t;
    else set = t;
  }
  return { rise, set };
}
