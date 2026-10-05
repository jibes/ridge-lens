import { describe, expect, it } from 'vitest';
import { AngleSmoother, deviceVectors, rotationMatrix, viewAngles } from './orientation';

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

describe('AngleSmoother', () => {
  // deterministisches Rauschen (Hand + Magnetometer), 60 Hz
  let seed = 1;
  const noise = (amp: number) => {
    seed = (seed * 16807) % 2147483647;
    return ((seed / 2147483647) * 2 - 1) * amp;
  };
  const step = 1000 / 60;

  it('damps ±2° heading jitter strongly while held still', () => {
    const s = new AngleSmoother();
    let maxDev = 0;
    for (let i = 0; i < 900; i++) {
      const out = s.update({ heading: 100 + noise(2), pitch: noise(0.5), roll: noise(0.5) }, i * step);
      if (i > 300) maxDev = Math.max(maxDev, Math.abs(out.heading - 100));
    }
    expect(maxDev).toBeLessThan(0.3);
  });

  it('follows a pan of 60°/s with little lag after stopping', () => {
    const s = new AngleSmoother();
    let t = 0;
    for (let i = 0; i < 120; i++, t += step) s.update({ heading: 10, pitch: 0, roll: 0 }, t);
    let out = { heading: 0, pitch: 0, roll: 0 };
    for (let i = 0; i <= 40; i++, t += step) out = s.update({ heading: 10 + i * 1, pitch: 0, roll: 0 }, t);
    for (let i = 0; i < 24; i++, t += step) out = s.update({ heading: 50, pitch: 0, roll: 0 }, t);
    // 0,4 s nach Ende des Schwenks höchstens ~2° Restabstand
    expect(50 - out.heading).toBeLessThan(2);
  });

  it('handles 0/360 wrap without jumping', () => {
    const s = new AngleSmoother();
    let out = { heading: 0, pitch: 0, roll: 0 };
    for (let i = 0; i < 200; i++) out = s.update({ heading: i % 2 ? 359.5 : 0.5, pitch: 0, roll: 0 }, i * step);
    expect(Math.min(out.heading, 360 - out.heading)).toBeLessThan(0.6);
  });
});
