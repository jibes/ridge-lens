import { describe, expect, it } from 'vitest';
import { project, type Camera } from './projection';
import { SkylineAccumulator, detectBody, detectStars, matchStars, type StarRef, extractSkyline, matchPitch, matchSkyline, matchSkylineHaze, screenToDir, searchWindows, type BodyTarget } from './vision';

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
  opts: { fog?: boolean; treeline?: number; clouds?: boolean; highClouds?: boolean; straightEdge?: boolean; testPattern?: boolean; treesLeft?: boolean; dusk?: boolean; noSnow?: boolean } = {},
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
      else if (opts.treesLeft && x < W * 0.5 && el < hz + 4 + 2 * Math.sin(x * 0.11) + Math.sin(x * 0.37)) rgb = [45, 70, 40]; // Baumkronen links bis über den Horizont
      else if (el > hz && opts.clouds && Math.sin(az * 0.9) + Math.sin(el * 2.3 + az * 0.2) > 1.2) rgb = [225, 228, 232]; // Wolken bis an den Grat
      else if (el > hz + 1 && opts.highClouds && Math.sin(az * 0.9) + Math.sin(el * 2.3 + az * 0.2) > 0.8) rgb = [225, 228, 232]; // Wolken über den Gipfeln
      else if (el > hz && opts.dusk) rgb = [225, 200, 200]; // Abendrot, Dunst
      else if (el > hz) rgb = [110 + r * 0.2, 160 + r * 0.15, 225];
      else if (el > hz - 0.6 && !opts.noSnow) rgb = [235, 238, 242]; // Schnee am Grat
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

/** Himmel mit Sonne (überstrahlt) bzw. nachts mit Mond; Gelände nach Horizontprofil. */
function renderSky(
  cam: Camera,
  horizon: Float32Array,
  bodies: { az: number; alt: number; glow: number }[],
  opts: { night?: boolean; overcast?: boolean } = {},
): Uint8ClampedArray {
  const img = new Uint8ClampedArray(COLS * ROWS * 4);
  const R = Math.PI / 180;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const [az, el] = screenToDir(cam, ((c + 0.5) * W) / COLS, ((r + 0.5) * H) / ROWS);
      const hz = horizon[Math.round((((az % 360) + 360) % 360) / AZ_STEP) % 3600];
      let rgb = opts.night ? [12, 14, 24] : opts.overcast ? [252, 252, 252] : [120, 165, 225];
      if (el > hz) {
        for (const b of bodies) {
          const d = Math.acos(Math.min(1, Math.sin(el * R) * Math.sin(b.alt * R) + Math.cos(el * R) * Math.cos(b.alt * R) * Math.cos((az - b.az) * R))) / R;
          if (d < b.glow) rgb = opts.night ? [215, 215, 205] : [255, 255, 255];
          else if (!opts.night && d < b.glow * 2.5) rgb = [235, 238, 240];
        }
      } else rgb = [235, 238, 242].map((v) => (el > hz - 0.6 ? v : v * 0.4) * (opts.night ? 0.25 : 1)); // Schnee am Grat, darunter Fels
      const p = (r * COLS + c) * 4;
      img[p] = rgb[0] + noise(4);
      img[p + 1] = rgb[1] + noise(4);
      img[p + 2] = rgb[2] + noise(4);
      img[p + 3] = 255;
    }
  }
  return img;
}

describe('sun and moon as reference', () => {
  const horizon = mountainHorizon();
  const sun: BodyTarget = { kind: 'sun', az: 207, alt: 9 };
  const sensor: Camera = { ...truth, heading: truth.heading + 5, pitch: truth.pitch + 1 };

  it('recovers compass and pitch from the sun disc', () => {
    const img = renderSky(truth, horizon, [{ az: sun.az, alt: sun.alt, glow: 1.2 }]);
    const m = detectBody(img, COLS, ROWS, sensor, sun, horizon, AZ_STEP);
    expect(m.ok).toBe(true);
    expect(m.dHeading).toBeCloseTo(-5, 0);
    expect(Math.abs(sensor.heading + m.dHeading - truth.heading)).toBeLessThan(0.3);
    expect(Math.abs(sensor.pitch + m.dPitch - truth.pitch)).toBeLessThan(0.3);
  });

  it('recovers from the moon at night', () => {
    const moon: BodyTarget = { kind: 'moon', az: 214, alt: 10 };
    const img = renderSky(truth, horizon, [{ az: moon.az, alt: moon.alt, glow: 0.4 }], { night: true });
    const m = detectBody(img, COLS, ROWS, sensor, moon, horizon, AZ_STEP);
    expect(m.ok).toBe(true);
    expect(Math.abs(sensor.heading + m.dHeading - truth.heading)).toBeLessThan(0.3);
  });

  it('rejects two bright spots, overcast sky and a sun behind the ridge', () => {
    const two = renderSky(truth, horizon, [{ az: sun.az, alt: sun.alt, glow: 1.2 }, { az: sun.az + 6, alt: sun.alt + 1, glow: 1.2 }]);
    expect(detectBody(two, COLS, ROWS, sensor, sun, horizon, AZ_STEP).ok).toBe(false);
    const grey = renderSky(truth, horizon, [], { overcast: true });
    expect(detectBody(grey, COLS, ROWS, sensor, sun, horizon, AZ_STEP).ok).toBe(false);
    // Sonne knapp unter dem Grat: nur die Überstrahlung darüber sichtbar
    const behind: BodyTarget = { kind: 'sun', az: 212, alt: 4.6 };
    const hid = renderSky(truth, horizon, [{ az: behind.az, alt: behind.alt, glow: 1.2 }]);
    expect(detectBody(hid, COLS, ROWS, sensor, behind, horizon, AZ_STEP).ok).toBe(false);
  });

  it('nothing bright → no correction', () => {
    const img = renderSky(truth, horizon, []);
    expect(detectBody(img, COLS, ROWS, sensor, sun, horizon, AZ_STEP).ok).toBe(false);
  });
});

/** Sanfte Hügel (Seeufer): Kurs kaum bestimmbar, Neigung schon. */
function gentleHorizon(): Float32Array {
  return new Float32Array(3600).map((_, i) => 0.5 + 0.12 * Math.sin((i / 10) * 0.25) + 0.05 * Math.sin((i / 10) * 1.3));
}

function skylinePoints(truth: Camera, sensor: Camera, horizon: Float32Array, opts: Parameters<typeof renderImage>[2]) {
  const img = renderImage(truth, horizon, opts);
  const sky = extractSkyline(img, COLS, ROWS, searchWindows(sensor, horizon, AZ_STEP, COLS, ROWS));
  const points: { x: number; y: number }[] = [];
  // wie im Worker: nur Spalten mit blauem Himmel über der Kante
  for (let c = 0; c < COLS; c++) if (sky.blueSky[c]) points.push({ x: ((c + 0.5) * W) / COLS, y: (sky.y[c] * H) / ROWS });
  return points;
}

describe('pitch-only alignment', () => {
  it('recovers pitch from a partly hidden, gentle horizon (trees left)', () => {
    const horizon = gentleHorizon();
    const sensor: Camera = { ...truth, heading: truth.heading + 3, pitch: truth.pitch + 1.5 };
    const points = skylinePoints(truth, sensor, horizon, { treesLeft: true });
    expect(matchSkyline(points, horizon, AZ_STEP, sensor, COLS).ok).toBe(false);
    const m = matchPitch(points, horizon, AZ_STEP, sensor, COLS);
    expect(m.ok).toBe(true);
    expect(m.dHeading).toBe(0);
    expect(Math.abs(sensor.pitch + m.dPitch - truth.pitch)).toBeLessThan(0.15);
  });

  it('works under a pale dusk sky', () => {
    const horizon = gentleHorizon();
    const sensor: Camera = { ...truth, heading: truth.heading + 3, pitch: truth.pitch + 1.5 };
    const m = matchPitch(skylinePoints(truth, sensor, horizon, { treesLeft: true, dusk: true, noSnow: true }), horizon, AZ_STEP, sensor, COLS);
    expect(m.ok).toBe(true);
    expect(Math.abs(sensor.pitch + m.dPitch - truth.pitch)).toBeLessThan(0.15);
    // Schneeband unter dem Grat: Kante Schnee/Fels darf nicht als Horizont gelten
    const snow = matchPitch(skylinePoints(truth, sensor, horizon, { treesLeft: true, dusk: true }), horizon, AZ_STEP, sensor, COLS);
    expect(!snow.ok || Math.abs(sensor.pitch + snow.dPitch - truth.pitch) < 0.15).toBe(true);
  });

  it('refuses where the heading matters (structured mountains)', () => {
    const horizon = mountainHorizon();
    const sensor: Camera = { ...truth, heading: truth.heading + 4, pitch: truth.pitch + 1 };
    const m = matchPitch(skylinePoints(truth, sensor, horizon, { treesLeft: true }), horizon, AZ_STEP, sensor, COLS);
    expect(m.ok).toBe(false);
  });

  it('refuses a straight roof edge in front of rolling terrain', () => {
    // Wellig, aber kursunabhängig genug für den Neigungsabgleich
    const horizon = new Float32Array(3600).map((_, i) => 0.6 + 0.4 * Math.sin((i / 10) * 0.15));
    const sensor: Camera = { ...truth, pitch: truth.pitch + 1 };
    const real = matchPitch(skylinePoints(truth, sensor, horizon, { treesLeft: true }), horizon, AZ_STEP, sensor, COLS);
    expect(real.ok).toBe(true);
    expect(Math.abs(sensor.pitch + real.dPitch - truth.pitch)).toBeLessThan(0.15);
    for (const frac of [0.48, 0.5, 0.52]) {
      const img = new Uint8ClampedArray(COLS * ROWS * 4);
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const x = ((c + 0.5) * W) / COLS;
          const y = ((r + 0.5) * H) / ROWS;
          const rgb = y < H * frac + (x - W / 2) * 0.05 ? [120, 170, 230] : [90, 80, 70];
          img.set([rgb[0] + noise(4), rgb[1] + noise(4), rgb[2] + noise(4), 255], (r * COLS + c) * 4);
        }
      }
      const sky = extractSkyline(img, COLS, ROWS, searchWindows(truth, horizon, AZ_STEP, COLS, ROWS));
      const points: { x: number; y: number }[] = [];
      for (let c = 0; c < COLS; c++) if (!Number.isNaN(sky.y[c])) points.push({ x: ((c + 0.5) * W) / COLS, y: (sky.y[c] * H) / ROWS });
      expect(matchPitch(points, horizon, AZ_STEP, truth, COLS).ok).toBe(false);
    }
  });

  it('refuses fog, test pattern and too few points', () => {
    const horizon = gentleHorizon();
    for (const opts of [{ fog: true }, { testPattern: true }, { treeline: 12 }]) {
      expect(matchPitch(skylinePoints(truth, truth, horizon, opts), horizon, AZ_STEP, truth, COLS).ok).toBe(false);
    }
  });
});

describe('haze: far mountains invisible', () => {
  // Nahe Hügel mit Struktur, dahinter ferne Gipfel, die im Bild fehlen
  const near = mountainHorizon();
  // Ferne Gipfel ragen über die nahe Silhouette
  const full = near.map((v, i) => {
    const az = i * AZ_STEP;
    let el = v;
    for (const [pAz, pEl, w] of [[199, 6, 0.8], [208, 5.5, 1], [217, 6.5, 0.7]]) el = Math.max(el, pEl - Math.abs(az - pAz) / w);
    return el;
  });

  function points(sensor: Camera) {
    const img = renderImage(truth, near, { noSnow: true });
    const sky = extractSkyline(img, COLS, ROWS, searchWindows(sensor, full, AZ_STEP, COLS, ROWS));
    const out: { x: number; y: number }[] = [];
    for (let c = 0; c < COLS; c++) if (!Number.isNaN(sky.y[c])) out.push({ x: ((c + 0.5) * W) / COLS, y: (sky.y[c] * H) / ROWS });
    return out;
  }

  it('matches the near silhouette instead of bending to invisible peaks', () => {
    for (const dh of [-4, 3, 6]) {
      const sensor: Camera = { ...truth, heading: truth.heading + dh, pitch: truth.pitch + 0.5 };
      const pts = points(sensor);
      const m = matchSkylineHaze(pts, [full, near], AZ_STEP, sensor, COLS);
      expect(m.ok).toBe(true);
      expect(m.band).toBe(1);
      expect(Math.abs(sensor.heading + m.dHeading - truth.heading)).toBeLessThan(0.3);
    }
  });

  it('clear view still uses the full silhouette', () => {
    const sensor: Camera = { ...truth, heading: truth.heading + 3, pitch: truth.pitch + 0.5 };
    const img = renderImage(truth, full, { noSnow: true });
    const sky = extractSkyline(img, COLS, ROWS, searchWindows(sensor, full, AZ_STEP, COLS, ROWS));
    const pts: { x: number; y: number }[] = [];
    for (let c = 0; c < COLS; c++) if (!Number.isNaN(sky.y[c])) pts.push({ x: ((c + 0.5) * W) / COLS, y: (sky.y[c] * H) / ROWS });
    const m = matchSkylineHaze(pts, [full, near], AZ_STEP, sensor, COLS);
    expect(m.ok).toBe(true);
    expect(m.band).toBe(0);
    expect(Math.abs(sensor.heading + m.dHeading - truth.heading)).toBeLessThan(0.3);
  });
});

describe('panoramic accumulation', () => {
  // Hügelland am See, unregelmäßig (keine Periodizität), Relief bis 0,7°
  const hills = new Float32Array(3600).map((_, i) => {
    const az = i / 10;
    let el = 0.8;
    for (const [c, w, a] of [[150, 6, 0.6], [171, 4, 0.4], [188, 9, 0.7], [204, 3, 0.3], [222, 7, 0.6], [241, 5, 0.5], [263, 8, 0.4]]) {
      el += a * Math.exp(-(((az - c) / w) ** 2));
    }
    return el;
  });
  const OFFSET = 6; // Kompass zeigt 6° zu wenig

  function feed(acc: SkylineAccumulator, headings: number[], offset = OFFSET) {
    for (const h of headings) {
      const t: Camera = { ...truth, heading: h, pitch: 1 };
      const sensor: Camera = { ...t, heading: h - offset, pitch: 1.4 };
      // Einzelbild: halb von Bäumen verdeckt, zu flach für den Kurs
      const pts = skylinePoints(t, sensor, hills, { treesLeft: true, noSnow: true });
      acc.add(pts, sensor, 0, 0, 0);
    }
  }

  it('single frames fail, the accumulated profile recovers heading and pitch', () => {
    const t: Camera = { ...truth, heading: 200, pitch: 1 };
    const sensor: Camera = { ...t, heading: 200 - OFFSET, pitch: 1.4 };
    expect(matchSkyline(skylinePoints(t, sensor, hills, { treesLeft: true, noSnow: true }), hills, AZ_STEP, sensor, COLS).ok).toBe(false);
    const acc = new SkylineAccumulator();
    feed(acc, [165, 185, 205, 225, 245]);
    const m = acc.match([hills], AZ_STEP, 1);
    expect(m.ok).toBe(true);
    expect(Math.abs(m.heading - OFFSET)).toBeLessThan(0.5);
    expect(Math.abs(m.pitch - -0.4)).toBeLessThan(0.15);
  });

  it('never accepts a wrong heading', () => {
    for (const off of [-14, -7, 3, 11, 17]) {
      const acc = new SkylineAccumulator();
      feed(acc, [170, 190, 210, 230], off);
      const m = acc.match([hills], AZ_STEP, 1);
      if (m.ok) expect(Math.abs(m.heading - off)).toBeLessThan(0.5);
    }
  });

  it('needs enough coverage and refuses a flat horizon', () => {
    const few = new SkylineAccumulator();
    feed(few, [200]);
    expect(few.match([hills], AZ_STEP, 1).ok).toBe(false);
    const flat = new SkylineAccumulator();
    const level = new Float32Array(3600).fill(0.8);
    for (const h of [165, 185, 205, 225, 245]) {
      const t: Camera = { ...truth, heading: h, pitch: 1 };
      flat.add(skylinePoints(t, t, level, { treesLeft: true, noSnow: true }), t, 0, 0, 0);
    }
    expect(flat.match([level], AZ_STEP, 1).ok).toBe(false);
  });
});

describe('stars at night', () => {
  const SW = 480;
  const SH = Math.round((SW * H) / W);
  const night: Camera = { heading: 120, pitch: 15, roll: 1, hfov: 50, width: W, height: H };
  const horizon = new Float32Array(3600).fill(1.5);
  // Pseudo-Zufall, reproduzierbar
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const catalog: StarRef[] = Array.from({ length: 40 }, () => ({ az: 60 + rnd() * 120, alt: 2 + rnd() * 55, mag: rnd() * 2.5 }));

  function renderNight(truthCam: Camera, extras: { x: number; y: number }[] = []): Uint8ClampedArray {
    const img = new Uint8ClampedArray(SW * SH * 4);
    const L = new Float32Array(SW * SH);
    for (let r = 0; r < SH; r++) {
      for (let c = 0; c < SW; c++) {
        const [, el] = screenToDir(truthCam, ((c + 0.5) * W) / SW, ((r + 0.5) * H) / SH);
        L[r * SW + c] = el > 1.5 ? 18 + noise(6) : 8 + noise(4);
        // Lichter der Stadt unter dem Horizont
        if (el < 1.2 && el > -1 && (c * 7 + r * 3) % 23 === 0) L[r * SW + c] = 220;
      }
    }
    const dot = (x: number, y: number, peak: number) => {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xi = Math.floor(x) + dx;
          const yi = Math.floor(y) + dy;
          if (xi < 0 || yi < 0 || xi >= SW || yi >= SH) continue;
          L[yi * SW + xi] += peak * Math.exp(-((xi + 0.5 - x) ** 2 + (yi + 0.5 - y) ** 2) / 0.8);
        }
      }
    };
    for (const s of catalog) {
      const p = project(truthCam, s.az, s.alt);
      if (p) dot((p[0] * SW) / W, (p[1] * SH) / H, 230 - 60 * s.mag);
    }
    for (const e of extras) dot(e.x, e.y, 200);
    for (let i = 0; i < SW * SH; i++) img.set([L[i], L[i], L[i] * 1.05, 255], i * 4);
    return img;
  }

  it('recovers heading and pitch from the star pattern', () => {
    const sensor: Camera = { ...night, heading: night.heading - 4, pitch: night.pitch + 1.5 };
    // Zwei Flugzeuge/Störpunkte
    const img = renderNight(night, [{ x: 100, y: 120 }, { x: 300, y: 260 }]);
    const blobs = detectStars(img, SW, SH, sensor, horizon, AZ_STEP);
    expect(blobs.length).toBeGreaterThanOrEqual(5);
    const m = matchStars(blobs, catalog);
    expect(m.ok).toBe(true);
    expect(Math.abs(sensor.heading + m.dHeading - night.heading)).toBeLessThan(0.15);
    expect(Math.abs(sensor.pitch + m.dPitch - night.pitch)).toBeLessThan(0.15);
  });

  it('ignores city lights and rejects a starless sky', () => {
    const empty = new Uint8ClampedArray(SW * SH * 4);
    for (let r = 0; r < SH; r++) {
      for (let c = 0; c < SW; c++) {
        const [, el] = screenToDir(night, ((c + 0.5) * W) / SW, ((r + 0.5) * H) / SH);
        const v = el > 1.5 ? 18 : (c * 7 + r * 3) % 23 === 0 && el > -1 ? 220 : 8;
        empty.set([v, v, v, 255], (r * SW + c) * 4);
      }
    }
    expect(detectStars(empty, SW, SH, night, horizon, AZ_STEP).length).toBe(0);
    expect(matchStars([], catalog).ok).toBe(false);
  });

  it('never accepts a wrong solution from random points', () => {
    for (let k = 0; k < 10; k++) {
      const blobs = Array.from({ length: 12 }, () => ({ az: 90 + rnd() * 60, el: 3 + rnd() * 40, contrast: 100 }));
      const m = matchStars(blobs, catalog);
      expect(m.ok).toBe(false);
    }
  });
});
