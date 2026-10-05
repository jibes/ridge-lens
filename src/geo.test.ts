import { describe, expect, it } from 'vitest';
import { bearing, curvatureDrop, deltaDeg, destination, distance, elevationAngle } from './geo';
import { decodeTerrarium, lonLatToPixel } from './dem';
import { project } from './projection';
import { parseEle, parseOverpassCsv, rowsToPeaks, tilesFor, type PeakRow } from './peaks';

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
  it('parses rows with localized names, skips incomplete lines', () => {
    // id, lat, lon, ele, name, name:de, name:en, name:fr, name:it, wikidata
    const csv =
      '1\t46.97\t8.25\t2128\tPilatus\t\t\t\t\n' +
      '2\t45.98\t7.66\t4478\tMatterhorn\t\t\tCervin\tCervino\tQ1374\n' +
      '3\t\t\t\t\t\t\t\t\n\n';
    const peaks = parseOverpassCsv(csv);
    expect(peaks).toHaveLength(2);
    expect(peaks[0]).toEqual({ id: 1, name: 'Pilatus', names: {}, lat: 46.97, lon: 8.25, ele: 2128, fame: 0 });
    expect(peaks[1].names).toEqual({ fr: 'Cervin', it: 'Cervino' });
    expect(peaks[1].fame).toBe(1);
  });

  it('tiles within radius, own tile first, sorted by distance', () => {
    const tiles = tilesFor(rigi, 100_000);
    expect(tiles[0]).toMatchObject({ lat: 47, lon: 8, dist: 0 });
    for (let i = 1; i < tiles.length; i++) expect(tiles[i].dist).toBeGreaterThanOrEqual(tiles[i - 1].dist);
    expect(tiles.every((t) => t.dist <= 100_000)).toBe(true);
    // 100 km um die Rigi: 46–47° N, 6–9° O (Ecken außerhalb fallen weg)
    expect(tiles.length).toBeGreaterThanOrEqual(6);
    expect(tiles.length).toBeLessThanOrEqual(12);
  });
});

describe('bundled peak rows', () => {
  it('converts rows, with and without fame', () => {
    const rows: PeakRow[] = [
      [1, 46.97, 8.25, 2128, 'Pilatus', '', '', '', 'Monte Pilato', 23],
      [2, 46.9, 8.2, null, 'Widderfeld', '', '', '', ''],
    ];
    expect(rowsToPeaks(rows)).toEqual([
      { id: 1, name: 'Pilatus', names: { it: 'Monte Pilato' }, lat: 46.97, lon: 8.25, ele: 2128, fame: 23 },
      { id: 2, name: 'Widderfeld', names: {}, lat: 46.9, lon: 8.2, ele: null, fame: 0 },
    ]);
  });
});
