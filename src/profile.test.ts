import { describe, expect, it } from 'vitest';
import { SensorProfile, orientationOf, pitchBand } from './profile';

const DAY = 86_400_000;

describe('SensorProfile', () => {
  it('needs a few matches, then averages (also across 0°/360°)', () => {
    const p = new SensorProfile();
    p.update('p|level', 358, 1, 1, 0);
    p.update('p|level', 2, 1.2, 1, 0);
    expect(p.get('p|level', 0)).toBeNull();
    p.update('p|level', 0, 0.8, 1, 0);
    const g = p.get('p|level', 0)!;
    expect(g.heading).toBeCloseTo(0, 5);
    expect(g.pitch).toBeCloseTo(1, 5);
    expect(g.n).toBeCloseTo(3, 5);
  });

  it('keeps postures apart and lets old values fade', () => {
    const p = new SensorProfile();
    for (let i = 0; i < 4; i++) p.update('p|level', 2, null, 1, 0);
    for (let i = 0; i < 4; i++) p.update('l|level', 9, null, 1, 0);
    expect(p.get('p|level', 0)!.heading).toBeCloseTo(2, 5);
    expect(p.get('l|level', 0)!.heading).toBeCloseTo(9, 5);
    expect(p.get('p|level', 0)!.pitch).toBeNull();
    // Nach drei Halbwertszeiten (63 Tage) zu wenig Gewicht
    expect(p.get('p|level', 63 * DAY)).toBeNull();
    // Neue Treffer überwiegen alte
    for (let i = 0; i < 4; i++) p.update('l|level', 3, null, 1, 42 * DAY);
    expect(p.get('l|level', 42 * DAY)!.heading).toBeLessThan(4.5);
  });

  it('postures and pitch bands with hysteresis', () => {
    expect(orientationOf(0)).toBe('p');
    expect(orientationOf(90)).toBe('l');
    expect(orientationOf(270)).toBe('r');
    expect(orientationOf(-90)).toBe('r');
    expect(pitchBand(5)).toBe('level');
    expect(pitchBand(25)).toBe('up');
    expect(pitchBand(21, 'level')).toBe('level');
    expect(pitchBand(24, 'level')).toBe('up');
    expect(pitchBand(-30)).toBe('down');
  });
});
