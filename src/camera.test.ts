import { describe, expect, it } from 'vitest';
import { displayHfov, fovLongFromDisplay } from './camera';

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
