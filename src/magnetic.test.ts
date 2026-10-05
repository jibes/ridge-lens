import { describe, expect, it } from 'vitest';
import { decimalYear, declination } from './magnetic';

describe('WMM2025 declination', () => {
  // Offizielle Testwerte WMM2025 (Jahr, Höhe km, Breite, Länge, Missweisung)
  const cases: [number, number, number, number, number][] = [
    [2025, 28, 89, -121, -99.77],
    [2025, 48, 80, -96, -29.91],
    [2025, 54, 82, 87, 54.89],
    [2025, 65, 43, 93, 0.5],
    [2025, 51, -33, 109, -5.49],
    [2025, 39, -59, -8, -15.75],
    [2025, 3, -50, -103, 27.96],
    [2025, 94, -29, -110, 15.74],
    [2025, 66, 14, 143, -0.19],
    [2025, 18, 0, 21, 1.29],
    [2025.5, 6, -36, -137, 20.28],
    [2025.5, 63, 26, 81, 0.51],
  ];
  it.each(cases)('%f %f km %f,%f → %f°', (year, alt, lat, lon, decl) => {
    expect(declination(lat, lon, year, alt)).toBeCloseTo(decl, 1);
  });

  it('Alps ≈ +3°', () => {
    const d = declination(47.06, 8.49, 2026.8);
    expect(d).toBeGreaterThan(2.5);
    expect(d).toBeLessThan(4);
  });

  it('decimal year', () => {
    expect(decimalYear(new Date(Date.UTC(2026, 0, 1)))).toBe(2026);
    expect(decimalYear(new Date(Date.UTC(2026, 6, 2, 12)))).toBeCloseTo(2026.5, 2);
  });
});
