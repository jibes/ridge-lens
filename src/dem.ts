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
  const png = await decodePng(new Uint8Array(await res.arrayBuffer()));
  if (!png || png.width !== TILE || png.height !== TILE) return null;
  return decodeTerrarium(png.rgba);
};

/**
 * PNG ohne Canvas dekodieren (8 bit, RGB/RGBA, ohne Interlacing – das Format der
 * Terrarium-Kacheln). Canvas-Auslesen verfälscht Brave absichtlich (Fingerprinting-
 * Schutz): ±1 im Rotkanal sind ±256 m Höhe.
 */
export async function decodePng(data: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8ClampedArray } | null> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0) !== 0x89504e47) return null;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 8 <= data.length; ) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(...data.subarray(p + 4, p + 8));
    const body = data.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(p + 8);
      height = view.getUint32(p + 12);
      const [depth, color, , , interlace] = body.subarray(8, 13);
      channels = color === 2 ? 3 : color === 6 ? 4 : 0;
      if (depth !== 8 || !channels || interlace) return null;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!channels || !idat.length) return null;
  // IDAT = zlib-Strom, den DecompressionStream('deflate') direkt versteht
  const raw = new Uint8Array(await new Response(new Blob(idat as BlobPart[]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? px[row + i - channels] : 0;
      const b = y > 0 ? px[row - stride + i] : 0;
      const c = i >= channels && y > 0 ? px[row - stride + i - channels] : 0;
      let v = raw[src + i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[row + i] = v;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < px.length; i += channels, j += 4) {
    rgba[j] = px[i];
    rgba[j + 1] = px[i + 1];
    rgba[j + 2] = px[i + 2];
    rgba[j + 3] = channels === 4 ? px[i + 3] : 255;
  }
  return { width, height, rgba };
}

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

  /**
   * Lädt alle Kacheln, die einen Kreis mit Radius `radius` (m) um `center` abdecken.
   * Liefert die Anzahl fehlgeschlagener Kacheln.
   */
  async load(
    center: LatLon,
    radius: number,
    fetcher: TileFetcher,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ total: number; failed: number }> {
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
    let failed = 0;
    const queue = jobs.slice();
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const [x, y] = job;
        const tile = await fetcher(this.z, x, y).catch(() => null);
        if (!tile) failed++;
        this.tiles.set(this.key(x, y), tile);
        onProgress?.(++done, jobs.length);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return { total: jobs.length, failed };
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
