import { describe, expect, it } from 'vitest';
import { castRay, extractRidges, linkRidges, occlusionAngle, type RidgePoint } from './panorama';

describe('extractRidges', () => {
  it('finds front ridge and skyline', () => {
    // Anstieg bis 2 km, Tal, dann höherer Kamm bei 10 km, danach abfallend
    const dists = [500, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 10000, 12000, 15000];
    const angles = [1, 2, 3, 4, 2, 1, 2, 4.5, 6, 3, 2];
    const { ridges, horizon } = extractRidges(dists, angles);
    expect(ridges).toEqual([
      { angle: 4, dist: 2000 },
      { angle: 6, dist: 10000 },
    ]);
    expect(horizon).toBe(6);
  });

  it('drops short occlusions (noise)', () => {
    const dists = [1000, 1100, 1200, 1300, 5000];
    const angles = [1, 1.2, 1.1, 1.3, 0.5];
    const { ridges } = extractRidges(dists, angles);
    expect(ridges).toEqual([{ angle: 1.3, dist: 1300 }]);
  });

  it('no ridge when terrain stays visible to the end', () => {
    expect(extractRidges([1000, 2000, 3000], [1, 2, 3]).ridges).toEqual([]);
  });
});

describe('linkRidges', () => {
  it('links similar points across bins and wraps around 360°', () => {
    const ridge = (dist: number, angle = 1): RidgePoint => ({ dist, angle });
    const bins: RidgePoint[][] = [[ridge(10000)], [ridge(10200), ridge(50000, 3)], [ridge(10300), ridge(51000, 3)], [ridge(30000)]];
    const { points, offsets } = linkRidges(bins, 90);
    const lines = Array.from({ length: offsets.length - 1 }, (_, i) => offsets[i + 1] - offsets[i]);
    expect(lines.sort()).toEqual([1, 2, 3]);
    expect(points.length).toBe(6 * 3);
  });

  it('closed ring is emitted once', () => {
    const bins = Array.from({ length: 4 }, () => [{ dist: 5000, angle: 2 }]);
    const { offsets } = linkRidges(bins, 90);
    expect(Array.from(offsets)).toEqual([0, 4]);
  });
});

describe('ray casting', () => {
  // Synthetisches Gelände: flach 500 m, Kamm 1500 m bei 5 km nördlich (konstant in Breite)
  const observer = { lat: 46, lon: 8 };
  const ridgeLat = 46 + 5000 / 111_195;
  const sample = (lat: number) => (Math.abs(lat - ridgeLat) < 0.002 ? 1500 : 500);
  const opts = { minDist: 50, maxDist: 20000, step: () => 50 };

  it('detects ridge to the north', () => {
    const ray = { dists: [] as number[], angles: [] as number[] };
    castRay(sample, observer, 502, 0, opts, ray);
    const { ridges } = extractRidges(ray.dists, ray.angles);
    expect(ridges.length).toBe(1);
    // Flaches Plateau: die vordere Kante (ca. 4.8 km) ist die Silhouette
    expect(ridges[0].dist).toBeGreaterThan(4700);
    expect(ridges[0].dist).toBeLessThan(4900);
    expect(ridges[0].angle).toBeCloseTo((Math.atan(998 / ridges[0].dist) * 180) / Math.PI, 1);
  });

  it('peak behind ridge is occluded, ridge itself not', () => {
    const occ = occlusionAngle(sample, observer, 502, 0, 15000, opts);
    expect(occ).toBeGreaterThan(9);
    const occFront = occlusionAngle(sample, observer, 502, 0, 4000, opts);
    expect(occFront).toBeLessThan(0.1);
  });
});
