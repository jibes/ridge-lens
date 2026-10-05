export const EARTH_RADIUS = 6_371_000;
/** Standard-Refraktionskoeffizient der Atmosphäre. */
export const REFRACTION_K = 0.13;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export interface LatLon {
  lat: number;
  lon: number;
}

/** Großkreisdistanz in Metern (Haversine). */
export function distance(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Anfangspeilung von a nach b in Grad, 0 = Nord, im Uhrzeigersinn, [0, 360). */
export function bearing(a: LatLon, b: LatLon): number {
  const φ1 = a.lat * RAD;
  const φ2 = b.lat * RAD;
  const Δλ = (b.lon - a.lon) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeDeg(Math.atan2(y, x) * DEG);
}

/** Zielpunkt nach `dist` Metern in Richtung `az` (Grad) auf dem Großkreis. */
export function destination(from: LatLon, az: number, dist: number): LatLon {
  const φ1 = from.lat * RAD;
  const λ1 = from.lon * RAD;
  const θ = az * RAD;
  const δ = dist / EARTH_RADIUS;
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * sinφ2);
  return { lat: φ2 * DEG, lon: ((λ2 * DEG + 540) % 360) - 180 };
}

/**
 * Scheinbarer Höhenwinkel (Grad) eines Punkts in Höhe `h` und Distanz `d`,
 * gesehen aus Augenhöhe `h0`, inkl. Erdkrümmung und Refraktion.
 */
export function elevationAngle(h0: number, h: number, d: number): number {
  return Math.atan2(h - h0 - curvatureDrop(d), d) * DEG;
}

/** Scheinbare Absenkung durch Erdkrümmung abzüglich Refraktion, in Metern. */
export function curvatureDrop(d: number): number {
  return ((d * d) / (2 * EARTH_RADIUS)) * (1 - REFRACTION_K);
}

export function normalizeDeg(a: number): number {
  return ((a % 360) + 360) % 360;
}

/** Vorzeichenbehaftete Winkeldifferenz a − b in (−180, 180]. */
export function deltaDeg(a: number, b: number): number {
  const d = normalizeDeg(a - b);
  return d > 180 ? d - 360 : d;
}
