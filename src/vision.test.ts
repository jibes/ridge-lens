import { describe, expect, it } from 'vitest';
import type { Camera } from './projection';
import { extractSkyline, matchSkyline, screenToDir, searchWindows } from './vision';
import { project } from './projection';

const AZ_STEP = 0.1;
const W = 390;
const H = 844;
const COLS = 160;
const ROWS = Math.round((COLS * H) / W);

/** Bergprofil: mehrere Wellen und spitze Gipfel (Höhenwinkel in Grad). */
function mountainHorizon(): Float32Array {
  const h = new Float32Array(3600);
  for (let i = 0; i < 3600; i++) {
    const az = i * AZ_STEP;
    let el = 1.5 + 1.2 * Math.sin(az * 0.12 * (Math.PI / 180) * 30) + 0.8 * Math.sin(az * 0.47 * (Math.PI / 180) * 30 + 1);
    for (const [pAz, pEl, w] of [[195, 4.5, 2], [203, 3.8, 1.2], [212, 5.2, 1.5], [221, 3.2, 2.5]]) {
      el = Math.max(el, pEl - Math.abs(az - pAz) / w);
    }
    h[i] = el;
  }
  return h;
}

/** Flacher Horizont (Meer, Ebene). */
function flatHorizon(): Float32Array {
  return new Float32Array(3600).fill(-0.2);
}

let seed = 3;
function noise(a: number) {
  seed = (seed * 16807) % 2147483647;
  return ((seed / 2147483647) * 2 - 1) * a;
}

/** Kamerabild synthetisieren: Himmel (Verlauf, Rauschen), Gelände mit Schneefeldern und Wald darunter. */
function renderImage(
  cam: Camera,
  horizon: Float32Array,
  opts: { fog?: boolean; treeline?: number; clouds?: boolean; highClouds?: boolean; straightEdge?: boolean; testPattern?: boolean } = {},
): Uint8ClampedArray {
  const img = new Uint8ClampedArray(COLS * ROWS * 4);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = ((c + 0.5) * W) / COLS;
      const y = ((r + 0.5) * H) / ROWS;
      const [az, el] = screenToDir(cam, x, y);
      const hz = horizon[Math.round((((az % 360) + 360) % 360) / AZ_STEP) % 3600];
      const p = (r * COLS + c) * 4;
      let rgb: number[];
      if (opts.fog) rgb = [200, 200, 205];
      else if (opts.straightEdge) rgb = y < H * 0.45 + (x - W / 2) * 0.05 ? [120, 170, 230] : [90, 80, 70]; // Hausdach vor Himmel
      else if (opts.testPattern) rgb = Math.hypot(x - 200, y - 380) < 150 ? [230, 230, 230] : (Math.floor(y / 120) % 2 ? [0, 140, 0] : [0, 110, 0]);
      else if (opts.treeline !== undefined && el < opts.treeline) rgb = [40, 60, 35]; // Wald im Vordergrund
      else if (el > hz && opts.clouds && Math.sin(az * 0.9) + Math.sin(el * 2.3 + az * 0.2) > 1.2) rgb = [225, 228, 232]; // Wolken bis an den Grat
      else if (el > hz + 1 && opts.highClouds && Math.sin(az * 0.9) + Math.sin(el * 2.3 + az * 0.2) > 0.8) rgb = [225, 228, 232]; // Wolken über den Gipfeln
      else if (el > hz) rgb = [110 + r * 0.2, 160 + r * 0.15, 225];
      else if (el > hz - 0.6) rgb = [235, 238, 242]; // Schnee am Grat
      else if (el > hz - 3) rgb = [120, 115, 110]; // Fels
      else rgb = [70, 85, 60];
      img[p] = rgb[0] + noise(8);
      img[p + 1] = rgb[1] + noise(8);
      img[p + 2] = rgb[2] + noise(8);
      img[p + 3] = 255;
    }
  }
  return img;
}

function runMatch(
  truth: Camera,
  sensor: Camera,
  horizon: Float32Array,
  opts?: { fog?: boolean; treeline?: number; clouds?: boolean; highClouds?: boolean; straightEdge?: boolean; testPattern?: boolean },
) {
  const img = renderImage(truth, horizon, opts);
  const windows = searchWindows(sensor, horizon, AZ_STEP, COLS, ROWS);
  const sky = extractSkyline(img, COLS, ROWS, windows);
  const points: { x: number; y: number }[] = [];
  for (let c = 0; c < COLS; c++) {
    if (!Number.isNaN(sky.y[c])) points.push({ x: ((c + 0.5) * W) / COLS, y: (sky.y[c] * H) / ROWS });
  }
  return matchSkyline(points, horizon, AZ_STEP, sensor, COLS);
}

const truth: Camera = { heading: 205, pitch: 2, roll: 3, hfov: 34, width: W, height: H };

describe('skyline matching', () => {
  it('recovers compass, pitch and field-of-view errors', () => {
    const sensor: Camera = { ...truth, heading: 210.5, pitch: 3.2, hfov: 34 * 1.08 };
    const m = runMatch(truth, sensor, mountainHorizon());
    expect(m.ok).toBe(true);
    expect(m.dHeading).toBeCloseTo(-5.5, 0);
    expect(m.dPitch).toBeCloseTo(-1.2, 0);
    expect(sensor.hfov * m.fovScale).toBeCloseTo(34, 0);
    // Gipfel landet nach Korrektur auf ±3 px
    const fixed = { ...sensor, heading: sensor.heading + m.dHeading, pitch: sensor.pitch + m.dPitch, hfov: sensor.hfov * m.fovScale };
    const [xT, yT] = project(truth, 212, 5.2)!;
    const [xF, yF] = project(fixed, 212, 5.2)!;
    expect(Math.hypot(xT - xF, yT - yF)).toBeLessThan(6);
  });

  it('works with clouds above the peaks', () => {
    const sensor: Camera = { ...truth, heading: 199, pitch: 1, hfov: 34 * 0.93 };
    const m = runMatch(truth, sensor, mountainHorizon(), { highClouds: true });
    expect(m.ok).toBe(true);
    expect(Math.abs(sensor.heading + m.dHeading - truth.heading)).toBeLessThan(0.3);
    expect(Math.abs(sensor.pitch + m.dPitch - truth.pitch)).toBeLessThan(0.2);
  });

  it('rejects a straight edge (roof, wall) in front of the sky', () => {
    for (const heading of [200, 205, 210, 215]) {
      expect(runMatch(truth, { ...truth, heading }, mountainHorizon(), { straightEdge: true }).ok).toBe(false);
    }
  });

  it('rejects unrelated images (test pattern)', () => {
    for (const heading of [195, 205, 215]) {
      expect(runMatch(truth, { ...truth, heading }, mountainHorizon(), { testPattern: true }).ok).toBe(false);
    }
  });

  it('rejects fog (no edge)', () => {
    const m = runMatch(truth, { ...truth, heading: 208 }, mountainHorizon(), { fog: true });
    expect(m.ok).toBe(false);
  });

  it('rejects a flat horizon (heading not observable)', () => {
    const m = runMatch(truth, { ...truth, heading: 208 }, flatHorizon());
    expect(m.ok).toBe(false);
    expect(m.reason).toBe('flat-horizon');
  });

  it('rejects forest/building in front of the mountains', () => {
    const m = runMatch(truth, { ...truth, heading: 208 }, mountainHorizon(), { treeline: 12 });
    expect(m.ok).toBe(false);
  });

  it('never accepts a wrong solution (random errors, with and without clouds)', () => {
    const horizon = mountainHorizon();
    let accepted = 0;
    let clearAccepted = 0;
    for (let i = 0; i < 12; i++) {
      const clouds = i % 2 === 1;
      const sensor: Camera = { ...truth, heading: truth.heading + noise(10), pitch: truth.pitch + noise(3), hfov: truth.hfov * (1 + noise(0.12)) };
      const m = runMatch(truth, sensor, horizon, { clouds });
      if (!m.ok) continue;
      accepted++;
      if (!clouds) clearAccepted++;
      expect(Math.abs(sensor.heading + m.dHeading - truth.heading)).toBeLessThan(0.5);
      expect(Math.abs(sensor.pitch + m.dPitch - truth.pitch)).toBeLessThan(0.3);
      expect(Math.abs((sensor.hfov * m.fovScale) / truth.hfov - 1)).toBeLessThan(0.03);
    }
    expect(clearAccepted).toBeGreaterThanOrEqual(5);
    expect(accepted).toBeGreaterThanOrEqual(6);
  });
});
