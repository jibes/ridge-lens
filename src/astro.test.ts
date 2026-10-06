import { describe, expect, it } from 'vitest';
import { bodyPath, julianDate, moonEcliptic, moonPosition, planetEquatorial, precess, starPosition, starsToHorizontal, sunEcliptic, sunPosition, terrainEvents, toEquatorial } from './astro';

const RAD = Math.PI / 180;
/** Winkelabstand zweier Himmelspositionen (Grad). */
function separation(a: { az: number; alt: number }, b: { az: number; alt: number }): number {
  const c = Math.sin(a.alt * RAD) * Math.sin(b.alt * RAD) + Math.cos(a.alt * RAD) * Math.cos(b.alt * RAD) * Math.cos((a.az - b.az) * RAD);
  return Math.acos(Math.min(1, c)) / RAD;
}

describe('astro', () => {
  it('Meeus example 25.a (sun) and 47.a (moon)', () => {
    // 1992-10-13 0h TD ≈ UT + 59 s
    const s = sunEcliptic(julianDate(new Date(Date.UTC(1992, 9, 13, 0, 0, 0))) );
    const se = toEquatorial(s.lon, 0, s.obliquity);
    expect(se.ra).toBeCloseTo(198.381, 1);
    expect(se.dec).toBeCloseTo(-7.785, 1);
    const m = moonEcliptic(julianDate(new Date(Date.UTC(1992, 3, 12, 0, 0, 0))));
    expect(m.lon).toBeCloseTo(133.163, 1);
    expect(m.lat).toBeCloseTo(-3.229, 1);
    expect(m.dist / 1000).toBeCloseTo(368.41, 0);
  });

  it('sun culminates at 90° − φ + δ', () => {
    // Rigi, Sommersonnenwende: Mittag ≈ 11:26 UTC
    let best = -90;
    for (let m = 600; m < 780; m++) best = Math.max(best, sunPosition(new Date(Date.UTC(2026, 5, 21, 0, m)), 47.0566, 8.4851).alt);
    expect(best).toBeCloseTo(90 - 47.0566 + 23.44, 0);
  });

  it('total solar eclipses: sun and moon coincide at the point of greatest eclipse', () => {
    for (const [date, lat, lon] of [
      [new Date(Date.UTC(2024, 3, 8, 18, 17, 16)), 25.29, -104.14],
      [new Date(Date.UTC(2017, 7, 21, 18, 25, 32)), 36.97, -87.67],
      [new Date(Date.UTC(2026, 7, 12, 17, 46, 0)), 65.2, -25.2],
    ] as const) {
      const sun = sunPosition(date, lat, lon);
      const moon = moonPosition(date, lat, lon);
      expect(separation(sun, moon)).toBeLessThan(0.25);
      expect(moon.fraction).toBeLessThan(0.01);
    }
  });

  it('full moon is fully lit and opposite the sun', () => {
    // Vollmond 2024-01-25 17:54 UTC
    const d = new Date(Date.UTC(2024, 0, 25, 17, 54));
    const moon = moonPosition(d, 47, 8);
    const sun = sunPosition(d, 47, 8);
    expect(moon.fraction).toBeGreaterThan(0.99);
    // Mond bis 5° neben der Ekliptik, dazu Parallaxe ≈ 1°
    expect(separation(sun, moon)).toBeGreaterThan(173);
    // Erstes Viertel 2024-01-18 03:53 UTC: halb, zunehmend
    const q = moonPosition(new Date(Date.UTC(2024, 0, 18, 3, 53)), 47, 8);
    expect(q.fraction).toBeCloseTo(0.5, 1);
    expect(q.waxing).toBe(true);
  });

  it('terrain events: rise later and set earlier behind a ridge', () => {
    const day = Date.UTC(2026, 2, 20);
    const path = bodyPath(sunPosition, 47, 8, day, day + 86_400_000, 2);
    const flat = terrainEvents(path, () => 0);
    const ridge = terrainEvents(path, () => 10);
    expect(flat.rise).not.toBeNull();
    expect(ridge.rise! - flat.rise!).toBeGreaterThan(50 * 60_000);
    expect(flat.set! - ridge.set!).toBeGreaterThan(50 * 60_000);
    // Tag-und-Nacht-Gleiche: ≈ 12 h über dem flachen Horizont (Refraktion verlängert leicht)
    expect((flat.set! - flat.rise!) / 3_600_000).toBeCloseTo(12.1, 0);
  });
});

/** Winkelabstand zweier Äquatorpositionen (Grad). */
function sepEq(a: { ra: number; dec: number }, b: { ra: number; dec: number }): number {
  return separation({ az: a.ra, alt: a.dec }, { az: b.ra, alt: b.dec });
}

describe('stars and planets', () => {
  it('precession: Meeus example 21.b (θ Persei, ohne Eigenbewegung)', () => {
    const p = precess(41.054063, 49.22775, 2_462_088.69);
    expect(p.ra).toBeCloseTo(41.5431, 2);
    expect(p.dec).toBeCloseTo(49.3492, 2);
  });

  it('bulk conversion matches single star', () => {
    const radec = new Float32Array([101.287, -16.716, 213.915, 19.182, 279.234, 38.784]);
    const out = new Float32Array(6);
    const d = new Date(Date.UTC(2026, 9, 6, 21, 0));
    starsToHorizontal(radec, d, 47.0566, 8.4851, out);
    for (let i = 0; i < 3; i++) {
      const p = starPosition(radec[2 * i], radec[2 * i + 1], d, 47.0566, 8.4851);
      expect(out[2 * i]).toBeCloseTo(p.az, 2);
      expect(out[2 * i + 1]).toBeCloseTo(p.alt, 2);
    }
  });

  it('Venus: Meeus example 33.a (1992-12-20)', () => {
    const d = new Date(Date.UTC(1992, 11, 20));
    const v = planetEquatorial('venus', d);
    const now = precess(v.ra, v.dec, julianDate(d));
    expect(sepEq(now, { ra: 316.1727, dec: -18.888 })).toBeLessThan(0.1);
    expect(v.mag).toBeLessThan(-3.9);
  });

  it('great conjunction Jupiter–Saturn 2020-12-21: 0.1° apart', () => {
    const d = new Date(Date.UTC(2020, 11, 21, 18));
    expect(sepEq(planetEquatorial('jupiter', d), planetEquatorial('saturn', d))).toBeLessThan(0.2);
  });

  it('Mars opposition 2020-10-13: opposite the sun, very bright', () => {
    const d = new Date(Date.UTC(2020, 9, 13, 23));
    const m = planetEquatorial('mars', d);
    const s = sunEcliptic(julianDate(d));
    const se = toEquatorial(s.lon, 0, 23.43928);
    expect(sepEq(m, se)).toBeGreaterThan(170);
    expect(m.mag).toBeLessThan(-2.3);
  });
});
