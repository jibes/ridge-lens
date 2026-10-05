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
 * Fehlt ein Kammpunkt in bis zu `maxGap − 1` Bins (Strahl knapp verfehlt),
 * wird die Lücke überbrückt statt die Linie zu teilen.
 */
export function linkRidges(
  bins: RidgePoint[][],
  azStep: number,
  relDist = 0.08,
  maxDAngle = 0.6,
  maxGap = 3,
): Polylines {
  const n = bins.length;
  // next[i][k] = Index im Bin i + gap[i][k] oder −1
  const next = bins.map((b) => new Int32Array(b.length).fill(-1));
  const gap = bins.map((b) => new Uint8Array(b.length));
  const hasPrev = bins.map((b) => new Uint8Array(b.length));
  for (let g = 1; g <= Math.min(maxGap, n - 1); g++) {
    for (let i = 0; i < n; i++) {
      const a = bins[i];
      const j = (i + g) % n;
      const b = bins[j];
      for (let k = 0; k < a.length; k++) {
        if (next[i][k] >= 0) continue;
        let best = -1;
        let bestScore = Infinity;
        for (let m = 0; m < b.length; m++) {
          if (hasPrev[j][m]) continue;
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
          next[i][k] = best;
          gap[i][k] = g;
          hasPrev[j][best] = 1;
        }
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
      i = (i + gap[i][k]) % n;
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

/**
 * Verwirft kurze Linienstücke (Azimut-Spanne < `minSpan` Grad): meist Geländerauschen
 * in der Ferne. Stücke der Silhouette vor dem Himmel bleiben.
 */
export function pruneLines(lines: Polylines, horizon: ArrayLike<number>, azStep: number, minSpan = 0.8): Polylines {
  const { points: p, offsets: off } = lines;
  const n = horizon.length;
  const pts: number[] = [];
  const offsets: number[] = [];
  for (let l = 0; l + 1 < off.length; l++) {
    const a = off[l];
    const b = off[l + 1];
    const span = (((p[(b - 1) * 3] - p[a * 3]) % 360) + 360) % 360;
    let keep = span >= minSpan - 1e-6;
    for (let k = a; !keep && k < b; k++) {
      keep = p[k * 3 + 1] >= horizon[Math.round(p[k * 3] / azStep) % n] - 1e-3;
    }
    if (!keep) continue;
    offsets.push(pts.length / 3);
    for (let k = a * 3; k < b * 3; k++) pts.push(p[k]);
  }
  offsets.push(pts.length / 3);
  return { points: new Float32Array(pts), offsets: new Uint32Array(offsets) };
}

/**
 * Bodenhöhe des Beobachters. Das Höhenmodell glättet Gipfel und Grate, dort
 * liegt der Wert oft Dutzende Meter zu tief und das eigene Gelände verdeckt
 * die Sicht. Fällt das Gelände ringsum (≥ 6 von 8 Richtungen in 60 m tiefer),
 * gilt der Standort als Gipfel/Grat und die höchste Stelle im Umkreis von 40 m zählt.
 */
export function observerGround(sample: Sampler, observer: LatLon): number {
  const center = sample(observer.lat, observer.lon, 0);
  if (Number.isNaN(center)) return center;
  const dirs = Array.from({ length: 8 }, (_, i) => i * 45);
  const lower = dirs.filter((az) => {
    const p = destination(observer, az, 60);
    return sample(p.lat, p.lon, 60) < center - 1;
  }).length;
  if (lower < 6) return center;
  let max = center;
  for (const r of [10, 20, 30, 40]) {
    for (const az of dirs) {
      const p = destination(observer, az, r);
      const h = sample(p.lat, p.lon, r);
      if (h > max) max = h;
    }
  }
  return max;
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

/**
 * Wie weit ein Punkt (az, angle) über die Silhouette in seiner Umgebung hinausragt:
 * Abstand zum tiefsten Silhouettenpunkt links bzw. rechts innerhalb ±`width` Grad,
 * der kleinere der beiden Werte (ein Gipfel braucht Abfall nach beiden Seiten).
 */
export function skylineRelief(horizon: ArrayLike<number>, azStep: number, az: number, angle: number, width = 1.5): number {
  const n = horizon.length;
  const c = Math.round(az / azStep);
  const k = Math.round(width / azStep);
  let left = Infinity;
  let right = Infinity;
  for (let i = 1; i <= k; i++) {
    left = Math.min(left, horizon[(((c - i) % n) + n) % n]);
    right = Math.min(right, horizon[(c + i) % n]);
  }
  return Math.max(0, Math.min(angle - left, angle - right));
}
