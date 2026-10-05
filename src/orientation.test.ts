import { describe, expect, it } from 'vitest';
import { deviceVectors, OrientationSmoother, rotationMatrix, viewAngles } from './orientation';

const angles = (a: number, b: number, g: number, screen = 0) => {
  const { f, r } = deviceVectors(a, b, g, screen);
  return viewAngles(f, r);
};

describe('orientation', () => {
  it('upright portrait facing north', () => {
    const v = angles(0, 90, 0);
    expect(v.heading).toBeCloseTo(0, 6);
    expect(v.pitch).toBeCloseTo(0, 6);
    expect(v.roll).toBeCloseTo(0, 6);
  });

  it('alpha rotates counter-clockwise: alpha 90 faces west', () => {
    expect(angles(90, 90, 0).heading).toBeCloseTo(270, 6);
    expect(angles(-30, 90, 0).heading).toBeCloseTo(30, 6);
  });

  it('tilting back raises the camera', () => {
    expect(angles(0, 100, 0).pitch).toBeCloseTo(10, 6);
    expect(angles(0, 0, 0).pitch).toBeCloseTo(-90, 6);
  });

  it('landscape (screen 90°), top pointing left, facing north', () => {
    const v = angles(90, 0, -90, 90);
    expect(v.heading).toBeCloseTo(0, 6);
    expect(v.pitch).toBeCloseTo(0, 6);
    expect(v.roll).toBeCloseTo(0, 6);
  });

  it('landscape (screen 270°), facing west', () => {
    // γ = 90: Gerät −z zeigt nach Westen, x_dev nach unten, y_dev (Oberkante) nach Norden = rechts
    const v = angles(0, 0, 90, 270);
    expect(v.pitch).toBeCloseTo(0, 6);
    expect(v.roll).toBeCloseTo(0, 6);
    expect(v.heading).toBeCloseTo(270, 6);
  });

  it('roll sign: right edge up is positive', () => {
    const v = viewAngles([0, 1, 0], [Math.cos(0.2), 0, Math.sin(0.2)]);
    expect(v.roll).toBeCloseTo((0.2 * 180) / Math.PI, 6);
  });
});

/** Euler-Zerlegung nach W3C (Rz·Rx·Ry) einer zeilenweisen Matrix. */
function toEuler(m: number[]): [number, number, number] {
  const D = 180 / Math.PI;
  return [Math.atan2(-m[1], m[4]) * D, Math.asin(m[7]) * D, Math.atan2(-m[6], m[8]) * D];
}

function mul(a: number[], b: number[]): number[] {
  const out = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return out;
}

describe('orientation round trip', () => {
  it('upright phone rotated about screen normal yields roll, keeps heading', () => {
    const rad = Math.PI / 180;
    const rz = (d: number) => [Math.cos(d * rad), -Math.sin(d * rad), 0, Math.sin(d * rad), Math.cos(d * rad), 0, 0, 0, 1];
    // Blick 213°, Neigung 0.5°, dann um Displaynormale −8° (rechte Kante nach unten)
    const base = rotationMatrix(-213, 90.5, 0);
    const [a, b, g] = toEuler(mul(base, rz(-8)));
    const v = angles(a, b, g);
    expect(v.heading).toBeCloseTo(213, 4);
    expect(v.pitch).toBeCloseTo(0.5, 4);
    expect(v.roll).toBeCloseTo(-8, 4);
  });
});

describe('OrientationSmoother', () => {
  const dir = (deg: number): [number, number, number] => [Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180), 0];
  const right = (deg: number): [number, number, number] => [Math.cos((deg * Math.PI) / 180), -Math.sin((deg * Math.PI) / 180), 0];
  const heading = (f: number[]) => ((Math.atan2(f[0], f[1]) * 180) / Math.PI + 360) % 360;

  it('damps ±1.5° jitter at 60 Hz to a fraction', () => {
    const s = new OrientationSmoother();
    let maxDev = 0;
    for (let i = 0; i < 600; i++) {
      const noisy = 100 + (i % 2 ? 1.5 : -1.5);
      const [f] = s.update(dir(noisy), right(noisy), i * 16.7);
      if (i > 120) maxDev = Math.max(maxDev, Math.abs(heading(f) - 100));
    }
    expect(maxDev).toBeLessThan(0.3);
  });

  it('follows a 40° turn within ~0.3 s', () => {
    const s = new OrientationSmoother();
    for (let i = 0; i < 60; i++) s.update(dir(0), right(0), i * 16.7);
    let f = dir(0);
    for (let i = 60; i < 78; i++) [f] = s.update(dir(40), right(40), i * 16.7);
    expect(heading(f)).toBeGreaterThan(38);
  });
});
