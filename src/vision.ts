/**
 * Bildabgleich: Horizontlinie im Kamerabild finden und mit dem berechneten Horizont
 * zur Deckung bringen. Ergebnis sind Korrekturen für Kompass (Kurs), Neigung und
 * Bildwinkel (Skalierung) – das Kamerabild selbst bleibt unverändert.
 */
import { cameraBasis, project, type Camera } from './projection';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Höhenwinkel des berechneten Horizonts bei Azimut `az` (linear zwischen 0,1°-Bins). */
export function horizonAt(horizon: ArrayLike<number>, azStep: number, az: number): number {
  const n = horizon.length;
  const f = ((((az % 360) + 360) % 360) / azStep) % n;
  const i = Math.floor(f);
  const t = f - i;
  return horizon[i] * (1 - t) + horizon[(i + 1) % n] * t;
}

/** Bildschirmpunkt → Blickrichtung (Azimut, Höhenwinkel) bei gegebener Kamera. */
export function screenToDir(cam: Camera, x: number, y: number): [number, number] {
  const { f, r, u } = cameraBasis(cam);
  const F = cam.width / 2 / Math.tan((cam.hfov / 2) * RAD);
  const xc = (x - cam.width / 2) / F;
  const yc = -(y - cam.height / 2) / F;
  const d = [f[0] + r[0] * xc + u[0] * yc, f[1] + r[1] * xc + u[1] * yc, f[2] + r[2] * xc + u[2] * yc];
  const n = Math.hypot(d[0], d[1], d[2]);
  return [((Math.atan2(d[0], d[1]) * DEG) + 360) % 360, Math.asin(d[2] / n) * DEG];
}

/** Bildschirm-y des berechneten Horizonts in Spalte x (Iteration, da Rolle x und y koppelt). */
function horizonY(cam: Camera, x: number, horizon: ArrayLike<number>, azStep: number, elShift = 0): number {
  let y = cam.height / 2;
  for (let k = 0; k < 4; k++) {
    const [az] = screenToDir(cam, x, y);
    const el = horizonAt(horizon, azStep, az) + elShift;
    // Höhenwinkel → y in der Bildspalte (Lochkamera, kleine Rolle)
    const F = cam.width / 2 / Math.tan((cam.hfov / 2) * RAD);
    const [, elAtY] = screenToDir(cam, x, y);
    y -= (Math.tan((el - elAtY) * RAD) * F);
  }
  return y;
}

/**
 * Suchfenster je Spalte (in Bildzeilen des verkleinerten Bilds): wo der berechnete
 * Horizont liegen kann, wenn der Kompass um bis zu ±`azErr`° und die Neigung um
 * ±`elErr`° daneben liegt.
 */
export function searchWindows(
  cam: Camera,
  horizon: ArrayLike<number>,
  azStep: number,
  cols: number,
  rows: number,
  azErr = 12,
  elErr = 4,
): [number, number][] {
  const out: [number, number][] = [];
  const sy = rows / cam.height;
  for (let c = 0; c < cols; c++) {
    const x = ((c + 0.5) * cam.width) / cols;
    const [az] = screenToDir(cam, x, cam.height / 2);
    let lo = Infinity;
    let hi = -Infinity;
    for (let d = -azErr; d <= azErr; d += 0.5) {
      const el = horizonAt(horizon, azStep, az + d);
      lo = Math.min(lo, el);
      hi = Math.max(hi, el);
    }
    const base = horizonAt(horizon, azStep, az);
    const yTop = horizonY(cam, x, horizon, azStep, hi - base + elErr) * sy;
    const yBot = horizonY(cam, x, horizon, azStep, lo - base - elErr) * sy;
    out.push([Math.max(1, Math.floor(yTop)), Math.min(rows - 2, Math.ceil(yBot))]);
  }
  return out;
}

export interface Skyline {
  /** Zeile der Himmel-/Geländegrenze je Spalte (NaN = nicht gefunden). */
  y: Float32Array;
  /** Trennschärfe je Spalte (0 = keine Kante). */
  conf: Float32Array;
  /** 1 = Kante mit blauem Himmel darüber; 0 = Ersatz (oberste Kante ohne Himmel). */
  blueSky: Uint8Array;
}

/**
 * Himmel-/Geländegrenze je Bildspalte: oberste starke Farbkante im Suchfenster
 * (von oben nach unten). So gilt bei verschneiten Graten die Kante Himmel/Schnee,
 * nicht Schnee/Fels. Der Himmel darüber muss gleichmäßig sein.
 */
export function extractSkyline(rgba: Uint8ClampedArray, w: number, h: number, windows: [number, number][]): Skyline {
  const y = new Float32Array(w).fill(NaN);
  const conf = new Float32Array(w);
  const blueSky = new Uint8Array(w);
  const col = new Float32Array(h * 3);
  for (let c = 0; c < w; c++) {
    const [y0, y1] = windows[c];
    if (y1 - y0 < 4) continue;
    for (let r = 0; r < h; r++) {
      const p = (r * w + c) * 4;
      col[r * 3] = rgba[p];
      col[r * 3 + 1] = rgba[p + 1];
      col[r * 3 + 2] = rgba[p + 2];
    }
    // Kantenstärke zwischen den zwei Zeilen darüber und den zwei Zeilen ab r
    const grad = (r: number) => {
      let d = 0;
      for (let k = 0; k < 3; k++) {
        const above = (col[(r - 2) * 3 + k] + col[(r - 1) * 3 + k]) / 2;
        const below = (col[r * 3 + k] + col[(r + 1) * 3 + k]) / 2;
        d += (above - below) ** 2;
      }
      return Math.sqrt(d);
    };
    const from = Math.max(2, y0);
    const to = Math.min(h - 3, y1);
    let maxG = 0;
    for (let r = from; r <= to; r++) maxG = Math.max(maxG, grad(r));
    if (maxG < 25) continue;
    // Kandidaten: lokale Maxima der Kantenstärke über der Schwelle (Himmel/Schnee ist oft
    // schwächer als Schnee/Fels darunter, daher niedrige relative Schwelle)
    const thr = Math.max(25, 0.3 * maxG);
    const cands: number[] = [];
    for (let r = from; r <= to; r++) {
      const g = grad(r);
      if (g >= thr && g >= grad(r - 1) && g >= grad(r + 1)) cands.push(r);
    }
    if (!cands.length) continue;
    // Blauanteil (b − r) der 3 Zeilen über bzw. unter einer Kante
    const blue = (a: number, b: number) => {
      let sum = 0;
      for (let r = Math.max(0, a); r < Math.min(h, b); r++) sum += col[r * 3 + 2] - col[r * 3];
      return sum / Math.max(1, Math.min(h, b) - Math.max(0, a));
    };
    // Unterste Kante mit blauem Himmel darüber: Wolken weiter oben stören nicht.
    // Ohne blauen Himmel (Hochnebel, Dämmerung): oberste Kante.
    let edge = -1;
    let skyFound = false;
    for (let i = cands.length - 1; i >= 0; i--) {
      const e = cands[i];
      const above = blue(e - 3, e);
      if (above > 30 && above - blue(e, e + 3) > 25) {
        edge = e;
        skyFound = true;
        break;
      }
    }
    if (edge < 0) {
      if (blue(0, from) > 30) continue; // blauer Himmel vorhanden, aber keine passende Kante
      edge = cands[0];
    }
    // Himmel oberhalb (bis zur Kante) muss gleichmäßig sein: Streuung zwischen Nachbarzeilen
    let rough = 0;
    for (let r = 1; r < edge - 1; r++) {
      let d = 0;
      for (let k = 0; k < 3; k++) d += (col[r * 3 + k] - col[(r - 1) * 3 + k]) ** 2;
      rough += Math.sqrt(d);
    }
    rough /= Math.max(1, edge - 2);
    const q = grad(edge) / (rough + 8);
    if (q < 1.5) continue;
    // Subpixel: Parabel durch die Kantenstärke um das Maximum
    const gm = grad(edge - 1 >= from ? edge - 1 : edge);
    const g0 = grad(edge);
    const gp = grad(edge + 1 <= to ? edge + 1 : edge);
    const den = gm - 2 * g0 + gp;
    const sub = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (gm - gp)) / den)) : 0;
    y[c] = edge + sub;
    conf[c] = q;
    blueSky[c] = skyFound ? 1 : 0;
  }
  return { y, conf, blueSky };
}

export interface MatchResult {
  ok: boolean;
  /** Korrekturen relativ zur übergebenen Kamera: Kurs (°), Neigung (°), Faktor auf das Sichtfeld. */
  dHeading: number;
  dPitch: number;
  fovScale: number;
  /** Mittlere (gekappte) Restabweichung in Grad. */
  cost: number;
  reason?: 'few-columns' | 'flat-horizon' | 'poor-fit' | 'ambiguous';
}

const CAP = 1.5;

/**
 * Sucht Kurs-, Neigungs- und Bildwinkel-Korrektur, die die Bild-Horizontpunkte
 * (Bildschirmkoordinaten) bestmöglich auf den berechneten Horizont legt.
 */
export function matchSkyline(
  points: { x: number; y: number }[],
  horizon: ArrayLike<number>,
  azStep: number,
  cam: Camera,
  totalColumns: number,
): MatchResult {
  const fail = (reason: MatchResult['reason'], cost = Infinity): MatchResult => ({ ok: false, dHeading: 0, dPitch: 0, fovScale: 1, cost, reason });
  if (points.length < totalColumns * 0.4) return fail('few-columns');

  // Horizont im Blickfeld muss Struktur haben, sonst ist der Kurs nicht bestimmbar
  const els = points.map((p) => horizonAt(horizon, azStep, screenToDir(cam, p.x, cam.height / 2)[0]));
  const m = els.reduce((s, v) => s + v, 0) / els.length;
  const std = Math.sqrt(els.reduce((s, v) => s + (v - m) ** 2, 0) / els.length);
  if (std < 0.25) return fail('flat-horizon');

  // Punkte relativ zur Bildmitte, einmal vorberechnet
  const px = points.map((p) => p.x - cam.width / 2);
  const py = points.map((p) => -(p.y - cam.height / 2));
  const errs = new Float64Array(px.length);
  /**
   * Robuste Restabweichung: Mittel der besten 70 % der Spalten (Wolkenkanten,
   * Bäume am Rand fallen heraus). `stride` > 1 nutzt nur jede n-te Spalte.
   */
  const evaluate = (dh: number, dp: number, s: number, stride = 1) => {
    const { f, r, u } = cameraBasis({ heading: cam.heading + dh, pitch: cam.pitch + dp, roll: cam.roll });
    const F = cam.width / 2 / Math.tan(((cam.hfov * s) / 2) * RAD);
    let n = 0;
    for (let i = 0; i < px.length; i += stride) {
      const xc = px[i] / F;
      const yc = py[i] / F;
      const dx = f[0] + r[0] * xc + u[0] * yc;
      const dy = f[1] + r[1] * xc + u[1] * yc;
      const dz = f[2] + r[2] * xc + u[2] * yc;
      const az = Math.atan2(dx, dy) * DEG;
      const el = Math.atan2(dz, Math.hypot(dx, dy)) * DEG;
      errs[n++] = Math.min(CAP, Math.abs(el - horizonAt(horizon, azStep, az)));
    }
    const e = errs.subarray(0, n).sort();
    const keep = Math.max(1, Math.round(n * 0.7));
    let sum = 0;
    for (let i = 0; i < keep; i++) sum += e[i];
    let inliers = 0;
    for (let i = 0; i < n; i++) if (e[i] < 0.3) inliers++;
    return { c: sum / keep, inliers: inliers / n };
  };

  // Grob: Kurs × Neigung × fünf Bildwinkel-Stufen, jede zweite Spalte
  const coarse: { dh: number; dp: number; s: number; c: number }[] = [];
  for (const s of [0.88, 0.94, 1, 1.06, 1.12]) {
    for (let dh = -12; dh <= 12; dh += 1) {
      for (let dp = -4; dp <= 4; dp += 0.5) coarse.push({ dh, dp, s, c: evaluate(dh, dp, s, 2).c });
    }
  }
  coarse.sort((a, b) => a.c - b.c);
  // Mehrere Startpunkte verfeinern (Grobraster kann das Tal knapp verfehlen)
  const starts = coarse.filter((e, i) => i === 0 || coarse.slice(0, i).every((o) => Math.abs(o.dh - e.dh) > 1.5)).slice(0, 3);

  let fb = { dh: 0, dp: 0, s: 1, c: Infinity, inliers: 0 };
  const refined: { dh: number; c: number }[] = [];
  for (const st of starts) {
    let local = { dh: st.dh, dp: st.dp, s: st.s, ...evaluate(st.dh, st.dp, st.s) };
    // Koordinatensuche mit schrumpfender Schrittweite
    for (const [hStep, pStep, sStep] of [[0.5, 0.25, 0.02], [0.2, 0.1, 0.01], [0.05, 0.025, 0.003]]) {
      let improved = true;
      while (improved) {
        improved = false;
        for (const [a, b, c] of [[hStep, 0, 0], [-hStep, 0, 0], [0, pStep, 0], [0, -pStep, 0], [0, 0, sStep], [0, 0, -sStep]]) {
          const cand = { dh: local.dh + a, dp: local.dp + b, s: local.s + c };
          if (Math.abs(cand.dh) > 13 || Math.abs(cand.dp) > 5 || cand.s < 0.84 || cand.s > 1.16) continue;
          const r = evaluate(cand.dh, cand.dp, cand.s);
          if (r.c < local.c - 1e-6) {
            local = { ...cand, ...r };
            improved = true;
          }
        }
      }
    }
    refined.push({ dh: local.dh, c: local.c });
    if (local.c < fb.c) fb = local;
  }

  // Gute Deckung liegt bei ≤ 0,1°; darüber passt Bild und Modell nicht sicher zusammen
  if (fb.c > 0.15 || fb.inliers < 0.5) return fail('poor-fit', fb.c);
  // Zweite, fast gleich gute Lösung mit deutlich anderem Kurs: mehrdeutig (gleichförmige Kette)
  const rival = refined.find((e) => Math.abs(e.dh - fb.dh) > 2);
  if (rival && rival.c < Math.max(fb.c * 1.6, fb.c + 0.1)) return fail('ambiguous', fb.c);
  // Schärfe: ±1,5° Kursversatz muss deutlich schlechter passen, sonst ist der Kurs nicht
  // bestimmt (gerade Kanten, flache Abschnitte, fremde Objekte)
  for (const side of [-1.5, 1.5]) {
    let c = Infinity;
    for (const dp of [-0.3, -0.15, 0, 0.15, 0.3]) c = Math.min(c, evaluate(fb.dh + side, fb.dp + dp, fb.s).c);
    if (c < Math.max(fb.c + 0.15, fb.c * 2.5)) return fail('ambiguous', fb.c);
  }
  return { ok: true, dHeading: fb.dh, dPitch: fb.dp, fovScale: fb.s, cost: fb.c };
}

/** Sonne bzw. Mond mit berechneter scheinbarer Lage. */
export interface BodyTarget {
  kind: 'sun' | 'moon';
  az: number;
  alt: number;
}

/**
 * Sonne/Mond als Fixpunkt: im Suchfenster um die berechnete Lage (±12° Kurs, ±4° Neigung)
 * muss genau ein heller, kompakter, runder Fleck über der Gelände-Silhouette liegen.
 * Liefert Kurs- und Neigungskorrektur (Bildwinkel bleibt, ein Punkt bestimmt ihn nicht).
 * Verworfen: kein oder mehrere Flecken, großflächig helle Wolken/Hochnebel, Reflexe
 * auf Schnee unter der Silhouette, Fleck am Fensterrand.
 */
export function detectBody(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  cam: Camera,
  body: BodyTarget,
  horizon: ArrayLike<number>,
  azStep: number,
): MatchResult {
  const fail = (reason: MatchResult['reason']): MatchResult => ({ ok: false, dHeading: 0, dPitch: 0, fovScale: 1, cost: Infinity, reason });
  const p = project(cam, body.az, body.alt);
  if (!p) return fail('few-columns');
  const sx = w / cam.width;
  const sy = h / cam.height;
  const F = cam.width / 2 / Math.tan((cam.hfov / 2) * RAD);
  const cx = p[0] * sx;
  const cy = p[1] * sy;
  const rx = F * Math.tan(12 * RAD) * sx;
  const ry = F * Math.tan(4 * RAD) * sy;
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(w - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(h - 1, Math.ceil(cy + ry));
  if (x1 - x0 < 4 || y1 - y0 < 4) return fail('few-columns');

  const lum = (i: number) => 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  let threshold: number;
  if (body.kind === 'sun') {
    threshold = 245;
  } else {
    // Mond nachts: deutlich heller als der (dunkle) Median des Fensters
    const vals: number[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) vals.push(lum(y * w + x));
    vals.sort((a, b) => a - b);
    threshold = Math.max(150, vals[vals.length >> 1] + 90);
  }
  const bright = (i: number) =>
    body.kind === 'sun' ? Math.min(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) >= threshold : lum(i) >= threshold;

  // Zusammenhängende helle Flecken im Fenster (4er-Nachbarschaft)
  const seen = new Uint8Array(w * h);
  const blobs: { n: number; sx: number; sy: number; minX: number; maxX: number; minY: number; maxY: number; edge: boolean }[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i0 = y * w + x;
      if (seen[i0] || !bright(i0)) continue;
      const blob = { n: 0, sx: 0, sy: 0, minX: x, maxX: x, minY: y, maxY: y, edge: false };
      const stack = [i0];
      seen[i0] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        const px = i % w;
        const py = (i - px) / w;
        blob.n++;
        blob.sx += px;
        blob.sy += py;
        blob.minX = Math.min(blob.minX, px);
        blob.maxX = Math.max(blob.maxX, px);
        blob.minY = Math.min(blob.minY, py);
        blob.maxY = Math.max(blob.maxY, py);
        if (px === x0 || px === x1 || py === y0 || py === y1) blob.edge = true;
        for (const [nx, ny] of [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]]) {
          if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
          const j = ny * w + nx;
          if (!seen[j] && bright(j)) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      blobs.push(blob);
    }
  }
  if (!blobs.length) return fail('few-columns');
  blobs.sort((a, b) => b.n - a.n);
  const b = blobs[0];
  if (blobs.length > 1 && blobs[1].n >= 0.3 * b.n) return fail('ambiguous');
  // Größe: Scheibe samt Überstrahlung höchstens ~6-facher Radius
  const r = Math.max(1, F * Math.tan(0.266 * RAD) * sx);
  if (b.edge || b.n > Math.PI * (6 * r + 2) ** 2) return fail('poor-fit');
  const bw = b.maxX - b.minX + 1;
  const bh = b.maxY - b.minY + 1;
  if (b.n >= 6 && (Math.max(bw, bh) / Math.min(bw, bh) > 1.8 || b.n / (bw * bh) < 0.45)) return fail('poor-fit');

  // Schwerpunkt → Richtung mit der Sensor-Kamera; muss über der Silhouette liegen
  const [az, el] = screenToDir(cam, (b.sx / b.n + 0.5) / sx, (b.sy / b.n + 0.5) / sy);
  if (el < horizonAt(horizon, azStep, az) + 0.3) return fail('poor-fit');
  const dHeading = ((((body.az - az) % 360) + 540) % 360) - 180;
  return { ok: true, dHeading, dPitch: body.alt - el, fovScale: 1, cost: 0 };
}

/**
 * Nur die Neigung abgleichen, wenn der volle Abgleich scheitert – etwa weil Bäume die
 * halbe Silhouette verdecken oder der Horizont zu flach für den Kurs ist. Zulässig nur,
 * wo der berechnete Horizont auf ±3° Kurs kaum variiert (ein Kursfehler verfälscht die
 * Neigung dann nicht). Verlangt eine dichte, breite Gruppe von Bildpunkten mit gleicher
 * Höhenabweichung; Ausreißer (Baumkronen, Wolken) bleiben außen vor. Nur Spalten mit
 * blauem Himmel über der Kante übergeben (Skyline.blueSky): ohne Himmel ist eine
 * waagrechte Kante (Muster, Mauer) nicht vom Horizont zu unterscheiden.
 */
export function matchPitch(
  points: { x: number; y: number }[],
  horizon: ArrayLike<number>,
  azStep: number,
  cam: Camera,
  totalColumns: number,
): MatchResult {
  const fail = (reason: MatchResult['reason']): MatchResult => ({ ok: false, dHeading: 0, dPitch: 0, fovScale: 1, cost: Infinity, reason });
  const minPoints = Math.max(0.15 * totalColumns, 12);
  if (points.length < minPoints) return fail('few-columns');
  const pts = points.map((p) => {
    const [az, el] = screenToDir(cam, p.x, p.y);
    const model = horizonAt(horizon, azStep, az);
    const shift = Math.max(Math.abs(horizonAt(horizon, azStep, az + 3) - model), Math.abs(horizonAt(horizon, azStep, az - 3) - model));
    return { x: p.x, r: model - el, model, shift };
  });
  // Kursunabhängig? Median der Änderung bei ±3° Kurs
  const shifts = pts.map((p) => p.shift).sort((a, b) => a - b);
  if (shifts[shifts.length >> 1] > 0.35) return fail('ambiguous');

  // Dichteste Gruppe gleicher Abweichung (±0,25°)
  const cluster = (center: number) => pts.filter((p) => Math.abs(p.r - center) < 0.25);
  let best: typeof pts = [];
  for (const p of pts) {
    const c = cluster(p.r);
    if (c.length > best.length) best = c;
  }
  if (best.length < Math.max(minPoints, 0.4 * pts.length)) return fail('poor-fit');
  const mean = best.reduce((s, p) => s + p.r, 0) / best.length;
  const std = Math.sqrt(best.reduce((s, p) => s + (p.r - mean) ** 2, 0) / best.length);
  const xs = best.map((p) => p.x);
  if (std > 0.15 || Math.max(...xs) - Math.min(...xs) < 0.25 * cam.width || Math.abs(mean) > 2) return fail('poor-fit');
  // Gerade Kante (Dach, Mauer) vor geformtem Gelände: Bildkante über alle Spalten schnurgerade,
  // Modell nicht → kein Horizont (Baumkronen machen die echte Bildkante dagegen unruhig)
  const allX = pts.map((p) => p.x);
  const lineStd = (ys: number[], xs = allX) => {
    const n = ys.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
    }
    const k = sxx ? sxy / sxx : 0;
    return Math.sqrt(ys.reduce((s, y, i) => s + (y - my - k * (xs[i] - mx)) ** 2, 0) / n);
  };
  const modelShape = lineStd(pts.map((p) => p.model));
  const imageShape = lineStd(pts.map((p) => p.model - p.r));
  // Abtastrauschen der Kante ≈ 0,05°; echte Silhouetten folgen dem Modell, Kanten nicht
  if (modelShape > 0.04 && imageShape < 0.5 * modelShape) return fail('poor-fit');
  // Eindeutig: keine zweite, ähnlich große Gruppe mit anderer Abweichung
  let rival = 0;
  for (const p of pts) {
    if (Math.abs(p.r - mean) < 0.6) continue;
    rival = Math.max(rival, cluster(p.r).filter((q) => Math.abs(q.r - mean) >= 0.6).length);
  }
  if (rival > 0.6 * best.length) return fail('ambiguous');
  return { ok: true, dHeading: 0, dPitch: mean, fovScale: 1, cost: std };
}
