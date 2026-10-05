import { destination, type LatLon } from './geo';

const TILE = 256;
const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

/** Terrarium-Kodierung: Höhe = R·256 + G + B/256 − 32768. */
export function decodeTerrarium(rgba: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    out[i] = rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768;
  }
  return out;
}

/** Globale Web-Mercator-Pixelkoordinaten auf Zoomstufe z. */
export function lonLatToPixel(lat: number, lon: number, z: number): [number, number] {
  const scale = TILE * 2 ** z;
  const x = ((lon + 180) / 360) * scale;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  return [x, y];
}

/** Bodenauflösung eines Pixels in Metern. */
export function metersPerPixel(lat: number, z: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** z);
}

export type TileFetcher = (z: number, x: number, y: number) => Promise<Float32Array | null>;

export const fetchTerrariumTile: TileFetcher = async (z, x, y) => {
  const res = await fetch(`${TERRARIUM_URL}/${z}/${x}/${y}.png`);
  if (!res.ok) return null;
  const bmp = await createImageBitmap(await res.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(TILE, TILE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return decodeTerrarium(ctx.getImageData(0, 0, TILE, TILE).data);
};

/** Höhenmodell einer Zoomstufe mit bilinearer Interpolation. */
export class Dem {
  private tiles = new Map<number, Float32Array | null>();
  private readonly n: number;

  constructor(readonly z: number) {
    this.n = 2 ** z;
  }

  private key(x: number, y: number): number {
    return y * this.n + x;
  }

  /** Lädt alle Kacheln, die einen Kreis mit Radius `radius` (m) um `center` abdecken. */
  async load(
    center: LatLon,
    radius: number,
    fetcher: TileFetcher,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    const corners = [0, 90, 180, 270].map((az) => destination(center, az, radius));
    const [x0, y0] = lonLatToPixel(corners[0].lat, corners[3].lon, this.z);
    const [x1, y1] = lonLatToPixel(corners[2].lat, corners[1].lon, this.z);
    const jobs: [number, number][] = [];
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) {
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) {
        const x = ((tx % this.n) + this.n) % this.n;
        if (ty >= 0 && ty < this.n && !this.tiles.has(this.key(x, ty))) jobs.push([x, ty]);
      }
    }
    let done = 0;
    const queue = jobs.slice();
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const [x, y] = job;
        this.tiles.set(this.key(x, y), await fetcher(this.z, x, y).catch(() => null));
        onProgress?.(++done, jobs.length);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  private pixel(px: number, py: number): number {
    const tx = Math.floor(px / TILE);
    const ty = Math.floor(py / TILE);
    const tile = this.tiles.get(this.key(((tx % this.n) + this.n) % this.n, ty));
    if (!tile) return NaN;
    return tile[(py - ty * TILE) * TILE + (px - tx * TILE)];
  }

  /** Höhe in Metern, NaN außerhalb geladener Kacheln. */
  elevation(lat: number, lon: number): number {
    const [x, y] = lonLatToPixel(lat, lon, this.z);
    // Pixelzentren liegen bei +0.5
    const fx = x - 0.5;
    const fy = y - 0.5;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const ax = fx - ix;
    const ay = fy - iy;
    const a = this.pixel(ix, iy);
    const b = this.pixel(ix + 1, iy);
    const c = this.pixel(ix, iy + 1);
    const d = this.pixel(ix + 1, iy + 1);
    return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
  }
}
