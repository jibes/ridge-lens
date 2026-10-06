import { describe, expect, it } from 'vitest';
import { displayHfov, fitTilt, fovLongFromDisplay, pickMainCamera } from './camera';

describe('camera field of view', () => {
  it('landscape video filling a landscape screen of same aspect keeps the long-side FOV', () => {
    expect(displayHfov(67, 1920, 1080, 960, 540)).toBeCloseTo(67, 6);
  });

  it('portrait screen crops the sides: horizontal FOV is the short-side FOV of a portrait video', () => {
    // Hochformat-Video 1080×1920 auf 390×844: Höhe bestimmt die Skalierung, Breite wird beschnitten
    const h = displayHfov(67, 1080, 1920, 390, 844);
    expect(h).toBeLessThan(40);
    expect(h).toBeGreaterThan(30);
  });

  it('inverse round-trips', () => {
    const h = displayHfov(70, 720, 1280, 390, 844);
    expect(fovLongFromDisplay(h, 720, 1280, 390, 844)).toBeCloseTo(70, 6);
  });
});

describe('pickMainCamera', () => {
  const cam = (id: string, label: string) => ({ id, label });
  it('Android: lowest camera2 index among back cameras', () => {
    const cams = [cam('a', 'camera2 2, facing back'), cam('b', 'camera2 1, facing front'), cam('c', 'camera2 0, facing back'), cam('d', 'camera2 3, facing back')];
    expect(pickMainCamera(cams)?.id).toBe('c');
  });
  it('iOS: plain back camera, not ultra wide or telephoto', () => {
    const cams = [cam('u', 'Back Ultra Wide Camera'), cam('m', 'Back Camera'), cam('t', 'Back Telephoto Camera'), cam('d', 'Back Dual Wide Camera')];
    expect(pickMainCamera(cams)?.id).toBe('m');
  });
  it('no labels (no permission) → null', () => {
    expect(pickMainCamera([cam('x', ''), cam('y', '')])).toBeNull();
  });
});

describe('fitTilt', () => {
  const R = Math.PI / 180;
  /** Bilder bei verschiedener Neigung: Kamera zeigt Winkel um den Faktor `wide` weiter als angenommen, Sensor-Neigung um `bias` daneben. */
  const samples = (wide: number, bias: number, axes: number[]) =>
    axes.map((a) => {
      // Horizont-Pixel bei angenommenem Winkel a liegt in Wahrheit bei atan(tan(a)·wide)
      const truth = Math.atan(Math.tan(a * R) * wide) / R;
      return { axis: a, pitch: truth - a + bias + Math.sin(a * 7) * 0.03 };
    });

  it('recovers field-of-view scale and pitch bias from tilting', () => {
    const f = fitTilt(samples(1.08, -1.2, [-12, -9, -6, -3, 0, 3, 6, 9, 12, 15]))!;
    expect(f.scale).toBeCloseTo(1.08, 1);
    expect(f.pitch).toBeCloseTo(-1.2, 1);
  });

  it('needs enough spread and points', () => {
    expect(fitTilt(samples(1.08, 0, [-2, -1, 0, 1, 2, 3, 1, 0]))).toBeNull();
    expect(fitTilt(samples(1.08, 0, [-10, 0, 10]))).toBeNull();
  });

  it('rejects scattered measurements', () => {
    const s = samples(1, 0, [-12, -9, -6, -3, 0, 3, 6, 9, 12]).map((x, i) => ({ ...x, pitch: x.pitch + (i % 2 ? 1 : -1) }));
    expect(fitTilt(s)).toBeNull();
  });
});
