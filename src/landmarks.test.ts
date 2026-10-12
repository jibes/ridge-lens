import { describe, expect, it } from 'vitest';
import { classifyLandmark, parseHeight } from './landmarks';
import type { Camera } from './projection';
import { detectSpikes, matchLandmarks, screenToDir, type LandmarkRef, type Spike } from './vision';

describe('OSM-Türme', () => {
  it('Höhe aus Freitext', () => {
    expect(parseHeight('187')).toBe(187);
    expect(parseHeight('45 m')).toBe(45);
    expect(parseHeight('150 ft')).toBe(46);
    expect(parseHeight('hoch')).toBeNull();
  });

  it('nur taugliche Arten', () => {
    expect(classifyLandmark({ man_made: 'tower', 'tower:type': 'communication', height: '187' })).toEqual({ kind: 'c', height: 187 });
    expect(classifyLandmark({ man_made: 'tower', 'tower:type': 'bell_tower' })?.kind).toBe('b');
    expect(classifyLandmark({ man_made: 'tower' })).toBeNull(); // Wasserturm o. Ä. ohne Höhe
    expect(classifyLandmark({ man_made: 'mast', height: '12' })).toBeNull();
    expect(classifyLandmark({ man_made: 'chimney', height: '120' })?.kind).toBe('h');
    expect(classifyLandmark({ natural: 'peak' })).toBeNull();
  });
});

const cam: Camera = { heading: 250, pitch: -2, roll: 0, hfov: 37, width: 384, height: 752 };
const BAND: [number, number] = [200, 330];
const W = 640;
const H = Math.round((W * (BAND[1] - BAND[0])) / cam.width);
/** Flacher Grat bei ~6° (Uetliberg von Zürich aus). */
const ridge = (az: number) => 6 + 0.3 * Math.sin(az * 0.4);
const dAz = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

let seed = 7;
const noise = (a: number) => {
  seed = (seed * 16807) % 2147483647;
  return ((seed / 2147483647) * 2 - 1) * a;
};

/** Streifen mit Turm (az 243,6°, Spitze 9°), Fahnenmast ganz vorn (bis über den Rand) und Laterne. */
function strip(view: Camera) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let r = 0; r < H; r++) {
    for (let x = 0; x < W; x++) {
      const [az, el] = screenToDir(view, ((x + 0.5) * view.width) / W, BAND[0] + ((r + 0.5) * (BAND[1] - BAND[0])) / H);
      let rgb: number[];
      if (Math.abs(dAz(az, 243.6)) < 0.07 && el < 9) rgb = [95, 95, 100];
      else if (Math.abs(dAz(az, 256)) < 0.15) rgb = [215, 215, 210];
      else if (el > ridge(az)) rgb = [95 + el * 2, 150 + el, 228];
      else rgb = [50 + noise(15), 70 + noise(15), 40 + noise(10)];
      px.set([rgb[0], rgb[1], rgb[2], 255], (r * W + x) * 4);
    }
  }
  return px;
}

/** Ideale Himmelsmaske (der Turm ist für die grobe Maske unsichtbar). */
function mask(view: Camera, size = 128) {
  const p = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [az, el] = screenToDir(view, ((x + 0.5) * view.width) / size, BAND[0] + ((y + 0.5) * (BAND[1] - BAND[0])) / size);
      p[y * size + x] = el > ridge(az) ? 1 : 0;
    }
  }
  return p;
}

describe('Spitzen im Bild', () => {
  it('findet den Turm, nicht den Fahnenmast', () => {
    const spikes = detectSpikes(strip(cam), W, H, cam, BAND, mask(cam), 128);
    expect(spikes.length).toBe(1);
    expect(Math.abs(dAz(spikes[0].az, 243.6))).toBeLessThan(0.1);
    expect(Math.abs(spikes[0].top - 9)).toBeLessThan(0.3);
  });

  it('richtet den Kurs am Turm aus (Kompass 2° daneben)', () => {
    const sensor: Camera = { ...cam, heading: 252 };
    // Bild entsteht mit dem wahren Kurs, ausgewertet mit dem Sensor
    const spikes = detectSpikes(strip(cam), W, H, sensor, BAND, mask(cam), 128);
    const refs: LandmarkRef[] = [
      { az: 243.6, dist: 4100, base: 6.5, top: 9, heightKnown: true, name: 'Uetliberg' },
      { az: 212, dist: 6000, base: 4, top: 5, heightKnown: false, name: 'weit weg' },
    ];
    const m = matchLandmarks(spikes, refs, [0], () => ({ c: 0.05, dp: 0 }), 0.05, { heading: 252, half: 18.5 });
    expect(m.ok).toBe(true);
    expect(Math.abs(m.dHeading - -2)).toBeLessThan(0.15);
    expect(m.towers).toEqual(['Uetliberg']);
  });
});

describe('Zuordnung', () => {
  const sil = () => ({ c: 0.08, dp: 0 });
  const VIEW = { heading: 100, half: 18.5 };
  const tower = (az: number, top = 3): LandmarkRef => ({ az, dist: 5000, base: top - 1.5, top, heightKnown: false, name: `T${az}` });
  const spike = (az: number, top = 3): Spike => ({ az, top, base: top - 1.5, width: 0.2 });

  it('zwei Türme mit gleichem Kurs', () => {
    const m = matchLandmarks([spike(100), spike(110)], [tower(103), tower(113), tower(140)], [0], sil, 0.08, VIEW);
    expect(m.ok).toBe(true);
    expect(m.dHeading).toBeCloseTo(3, 5);
  });

  it('ein Turm, zwei mögliche Spitzen: mehrdeutig', () => {
    const m = matchLandmarks([spike(100), spike(107)], [tower(103)], [0], sil, 0.08, VIEW);
    expect(m.ok).toBe(false);
  });

  it('ein Turm ohne Höhe vor flachem Horizont: nicht genug', () => {
    const m = matchLandmarks([spike(100)], [tower(103)], [0], sil, Infinity, VIEW);
    expect(m.ok).toBe(false);
  });

  it('zufällige Spitzen (Laternen, Bootsmasten) und Türme: kein falscher Kurs', () => {
    // Silhouette wie am Uetliberg: flaches Tal ±2° um den wahren Kurs (0)
    const valley = (dh: number) => ({ c: 0.05 + 0.025 * Math.abs(dh), dp: 0 });
    // Nie außerhalb des Silhouettentals; darin (1–2° daneben) selten – die App verlangt für
    // Korrekturen über 1,5° zudem zwei übereinstimmende Bilder
    let off1 = 0;
    let off2 = 0;
    for (let i = 0; i < 1000; i++) {
      const spikes = Array.from({ length: 4 }, () => spike(100 + noise(18), 3 + noise(1)));
      const towers = Array.from({ length: 6 }, () => tower(100 + noise(30), 3 + noise(1)));
      const m = matchLandmarks(spikes, towers, [0], valley, 0.05, VIEW);
      if (m.ok && Math.abs(m.dHeading) > 1) off1++;
      if (m.ok && Math.abs(m.dHeading) > 2) off2++;
    }
    expect(off2).toBe(0);
    expect(off1).toBeLessThan(10);
  });

  it('flacher Horizont: zwei Türme nur mit bekannter Höhe und passender Neigung', () => {
    const known = (az: number, top: number): LandmarkRef => ({ ...tower(az, top), heightKnown: true });
    const flat = () => ({ c: 0.05, dp: 0 });
    expect(matchLandmarks([spike(100, 3), spike(110, 4)], [tower(103, 3), tower(113, 4)], [0], flat, Infinity, VIEW).ok).toBe(false);
    expect(matchLandmarks([spike(100, 3), spike(110, 4)], [known(103, 3), known(113, 4)], [0], flat, Infinity, VIEW).ok).toBe(true);
    expect(matchLandmarks([spike(100, 3), spike(110, 4)], [known(103, 4.5), known(113, 3)], [0], flat, Infinity, VIEW).ok).toBe(false);
  });
});
