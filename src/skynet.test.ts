// @ts-ignore -- Node-Typen sind nicht eingebunden; läuft nur unter Vitest
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SkyNet, SKYNET_SIZE } from './skynet';
import { extractSkylineSeg } from './vision';

function load() {
  const model = JSON.parse(readFileSync('public/models/skynet.json', 'utf8'));
  const b = readFileSync('public/models/skynet.bin');
  return new SkyNet(model, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)));
}

/** Blauer Himmel über einer bewaldeten Bergsilhouette (Sinus, Textur), RGBA. */
function scene(w: number, h: number, ridge: (x: number) => number) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const sky = y < ridge(x);
      const n = ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1) * 50;
      px.set(sky ? [90 + y * 0.3, 150 + y * 0.2, 235, 255] : [50 + n, 80 + n, 35 + n * 0.5, 255], p);
    }
  }
  return px;
}

describe('SkyNet', () => {
  const net = load();
  const ridge = (x: number) => 0.45 + 0.08 * Math.sin(x * 0.05);

  it('erkennt Himmel über und Gelände unter der Silhouette', () => {
    const S = SKYNET_SIZE;
    const { size, prob } = net.segment(scene(S, S, (x) => ridge(x) * S), S, S);
    expect(size).toBe(128);
    let top = 0;
    let bottom = 0;
    for (let x = 0; x < size; x++) {
      top += prob[10 * size + x];
      bottom += prob[120 * size + x];
    }
    expect(top / size).toBeGreaterThan(0.8);
    expect(bottom / size).toBeLessThan(0.2);
  });

  it('liefert die Silhouette je Spalte auf ±2 Zeilen', () => {
    const w = 160;
    const h = 300;
    const px = scene(w, h, (x) => ridge(x * 1.6) * h);
    const mask = net.segment(scene(SKYNET_SIZE, SKYNET_SIZE, (x) => ridge(x) * SKYNET_SIZE), SKYNET_SIZE, SKYNET_SIZE);
    const windows = Array.from({ length: w }, () => [20, h - 20] as [number, number]);
    const sky = extractSkylineSeg(px, w, h, windows, mask.prob, mask.size);
    let n = 0;
    for (let c = 0; c < w; c++) {
      if (Number.isNaN(sky.y[c])) continue;
      n++;
      expect(Math.abs(sky.y[c] - ridge((c + 0.5) * 1.6) * h)).toBeLessThan(2);
    }
    expect(n).toBeGreaterThan(0.9 * w);
  });
});
