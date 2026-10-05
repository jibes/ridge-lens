import { destination, elevationAngle, type LatLon } from './geo';

/** Geländehöhe (m) am Punkt, `d` = Distanz vom Beobachter (für Wahl der Auflösung). */
export type Sampler = (lat: number, lon: number, d: number) => number;

export interface RidgePoint {
  angle: number;
  dist: number;
}

export interface RayOptions {
  /** Erster Abtastpunkt (m); verhindert, dass der eigene Standort sich selbst verdeckt. */
  minDist: number;
  maxDist: number;
  /** Schrittweite (m) als Funktion der Distanz. */
  step: (d: number) => number;
}

/** Tastet einen Strahl ab: Distanzen und scheinbare Höhenwinkel. */
export function castRay(
  sample: Sampler,
  observer: LatLon,
  h0: number,
  az: number,
  opts: RayOptions,
  out: { dists: number[]; angles: number[] },
): void {
  out.dists.length = 0;
  out.angles.length = 0;
  for (let d = opts.minDist; d <= opts.maxDist; d += opts.step(d)) {
    const p = destination(observer, az, d);
    const h = sample(p.lat, p.lon, d);
    if (Number.isNaN(h)) continue;
    out.dists.push(d);
    out.angles.push(elevationAngle(h0, h, d));
  }
}

/**
 * Kammlinien entlang eines Strahls: der letzte sichtbare Punkt vor einem
 * verdeckten Abschnitt. Kurze Verdeckungen (Rauschen, kleine Mulden) werden
 * verworfen, sofern dahinter wieder Gelände sichtbar wird.
 */
export function extractRidges(
  dists: ArrayLike<number>,
  angles: ArrayLike<number>,
  minGap = 300,
  relGap = 0.04,
): { ridges: RidgePoint[]; horizon: number } {
  const ridges: RidgePoint[] = [];
  let maxA = -Infinity;
  let lastVisible = -1;
  let pending = -1;
  for (let i = 0; i < angles.length; i++) {
    if (angles[i] >= maxA) {
      if (pending >= 0) {
        const span = dists[i] - dists[pending];
        if (span > Math.max(minGap, relGap * dists[pending])) {
          ridges.push({ angle: angles[pending], dist: dists[pending] });
        }
        pending = -1;
      }
      maxA = angles[i];
      lastVisible = i;
    } else if (pending < 0) {
      pending = lastVisible;
    }
  }
  // Bis zum Ende verdeckt: das ist die Silhouette vor dem Himmel.
  if (pending >= 0) ridges.push({ angle: angles[pending], dist: dists[pending] });
  return { ridges, horizon: maxA };
}

export interface Polylines {
  /** Je Punkt [az, angle, dist], hintereinander. */
  points: Float32Array;
  /** Startindex (in Punkten) jeder Linie; letzter Eintrag = Gesamtzahl. */
  offsets: Uint32Array;
}

/**
 * Verbindet Kammpunkte benachbarter Azimut-Bins zu Linien, wenn Distanz und
 * Winkel ähnlich sind. Bins sind ringförmig (letzter Bin grenzt an ersten).
 */
export function linkRidges(
  bins: RidgePoint[][],
  azStep: number,
  relDist = 0.08,
  maxDAngle = 0.6,
): Polylines {
  const n = bins.length;
  // next[i][k] = Index in Bin i+1 oder −1
  const next = bins.map((b) => new Int32Array(b.length).fill(-1));
  const hasPrev = bins.map((b) => new Uint8Array(b.length));
  for (let i = 0; i < n; i++) {
    const a = bins[i];
    const j = (i + 1) % n;
    const b = bins[j];
    const taken = new Uint8Array(b.length);
    for (let k = 0; k < a.length; k++) {
      let best = -1;
      let bestScore = Infinity;
      for (let m = 0; m < b.length; m++) {
        if (taken[m]) continue;
        const dd = Math.abs(b[m].dist - a[k].dist) / a[k].dist;
        const da = Math.abs(b[m].angle - a[k].angle);
        if (dd > relDist || da > maxDAngle) continue;
        const score = dd / relDist + da / maxDAngle;
        if (score < bestScore) {
          bestScore = score;
          best = m;
        }
      }
      if (best >= 0) {
        taken[best] = 1;
        next[i][k] = best;
        hasPrev[j][best] = 1;
      }
    }
  }

  const visited = bins.map((b) => new Uint8Array(b.length));
  const pts: number[] = [];
  const offsets: number[] = [];
  const walk = (i: number, k: number) => {
    offsets.push(pts.length / 3);
    let steps = 0;
    while (k >= 0 && !visited[i][k] && steps++ <= n) {
      visited[i][k] = 1;
      pts.push(i * azStep, bins[i][k].angle, bins[i][k].dist);
      const nk = next[i][k];
      i = (i + 1) % n;
      k = nk;
    }
  };
  // Zuerst Linien mit Anfang, dann übrige (geschlossene Ringe um 360°).
  for (const firstPass of [true, false]) {
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < bins[i].length; k++) {
        if (visited[i][k] || (firstPass && hasPrev[i][k])) continue;
        walk(i, k);
      }
    }
  }
  offsets.push(pts.length / 3);
  return { points: new Float32Array(pts), offsets: new Uint32Array(offsets) };
}

/** Maximaler Höhenwinkel des Geländes zwischen Beobachter und Ziel. */
export function occlusionAngle(
  sample: Sampler,
  observer: LatLon,
  h0: number,
  az: number,
  targetDist: number,
  opts: RayOptions,
): number {
  const end = targetDist - Math.max(300, 0.03 * targetDist);
  let maxA = -Infinity;
  for (let d = opts.minDist; d < end; d += opts.step(d)) {
    const p = destination(observer, az, d);
    const h = sample(p.lat, p.lon, d);
    if (!Number.isNaN(h)) maxA = Math.max(maxA, elevationAngle(h0, h, d));
  }
  return maxA;
}
