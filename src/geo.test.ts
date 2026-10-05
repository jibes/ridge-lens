import { describe, expect, it } from 'vitest';
import { bearing, curvatureDrop, deltaDeg, destination, distance, elevationAngle } from './geo';
import { decodeTerrarium, lonLatToPixel } from './dem';
import { project } from './projection';
import { parseEle, parseOverpassCsv, peakBBox } from './peaks';

const rigi = { lat: 47.0566, lon: 8.4851 };
const pilatus = { lat: 46.979, lon: 8.2552 };

describe('geo', () => {
  it('distance & bearing Rigi → Pilatus', () => {
    expect(distance(rigi, pilatus) / 1000).toBeCloseTo(19.3, 0);
    expect(bearing(rigi, pilatus)).toBeGreaterThan(240);
    expect(bearing(rigi, pilatus)).toBeLessThan(250);
  });

  it('destination is inverse of distance/bearing', () => {
    const p = destination(rigi, 123.4, 87_000);
    expect(distance(rigi, p)).toBeCloseTo(87_000, -1);
    expect(bearing(rigi, p)).toBeCloseTo(123.4, 1);
  });

  it('curvature with refraction: ~0.68 m at 3.3 km, ~682 m at 100 km', () => {
    expect(curvatureDrop(100_000)).toBeCloseTo(682.9, 0);
    expect(curvatureDrop(3_300)).toBeCloseTo(0.74, 1);
  });

  it('elevation angle: equal height far away is below horizon', () => {
    expect(elevationAngle(1000, 1000, 1000)).toBeCloseTo(0, 2);
    expect(elevationAngle(1000, 1000, 100_000)).toBeLessThan(-0.38);
    expect(elevationAngle(0, 1000, 1000)).toBeCloseTo(45, 1);
  });

  it('deltaDeg wraps', () => {
    expect(deltaDeg(10, 350)).toBe(20);
    expect(deltaDeg(350, 10)).toBe(-20);
  });
});

describe('dem', () => {
  it('decodes terrarium', () => {
    // 1797 m → 34565 = 135·256 + 5
    expect(decodeTerrarium(new Uint8ClampedArray([135, 5, 0, 255]))[0]).toBe(1797);
    expect(decodeTerrarium(new Uint8ClampedArray([128, 0, 128, 255]))[0]).toBe(0.5);
  });

  it('web mercator pixel', () => {
    expect(lonLatToPixel(0, 0, 0)).toEqual([128, 128]);
    const [x, y] = lonLatToPixel(rigi.lat, rigi.lon, 10);
    expect(Math.floor(x / 256)).toBe(536);
    expect(Math.floor(y / 256)).toBe(359);
  });
});

describe('projection', () => {
  const cam = { heading: 90, pitch: 0, roll: 0, hfov: 90, width: 1000, height: 500 };
  it('center and edges', () => {
    expect(project(cam, 90, 0)).toEqual([500, 250]);
    const [x] = project(cam, 135, 0)!;
    expect(x).toBeCloseTo(1000, 6);
    expect(project(cam, 270, 0)).toBeNull();
  });
  it('roll: right edge up tilts horizon down on the right', () => {
    const [x, y] = project({ ...cam, roll: 10 }, 120, 0)!;
    expect(x).toBeGreaterThan(500);
    expect(y).toBeGreaterThan(250);
    // Bildmitte bleibt
    expect(project({ ...cam, roll: 10 }, 90, 0)).toEqual([500, 250]);
  });
  it('pitch moves horizon down', () => {
    const [, y] = project({ ...cam, pitch: 10 }, 90, 0)!;
    expect(y).toBeGreaterThan(250);
  });
});

describe('peaks', () => {
  it('parses OSM ele', () => {
    expect(parseEle('1797')).toBe(1797);
    expect(parseEle("2'502")).toBe(2502);
    expect(parseEle('2106 m')).toBe(2106);
    expect(parseEle('4478,5')).toBe(4478.5);
    expect(parseEle('1000 ft')).toBeCloseTo(304.8);
    expect(parseEle('unknown')).toBeNull();
    expect(parseEle(undefined)).toBeNull();
  });
});

describe('overpass csv', () => {
  it('parses rows, prefers name:de, skips incomplete lines', () => {
    const csv = '1\t46.97\t8.25\tPilatus\t\t2128\n2\t46.55\t7.96\tJungfrau\tJungfrau\t4158\n3\t46.6\t8.0\tCervin\tMatterhorn\t4478\n\n';
    const peaks = parseOverpassCsv(csv);
    expect(peaks.map((p) => p.name)).toEqual(['Pilatus', 'Jungfrau', 'Matterhorn']);
    expect(peaks[0]).toEqual({ id: 1, name: 'Pilatus', lat: 46.97, lon: 8.25, ele: 2128 });
  });

  it('bbox covers the radius and is rounded outward', () => {
    const [s, w, n, e] = peakBBox(rigi, 100_000);
    expect(s).toBeLessThan(rigi.lat - 0.9);
    expect(n).toBeGreaterThan(rigi.lat + 0.9);
    expect(e - w).toBeGreaterThan(2.6);
    expect(Math.round(s * 20)).toBeCloseTo(s * 20, 6);
  });
});

