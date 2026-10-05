import { describe, expect, it } from 'vitest';
import { decodePng } from './dem';

/** Minimal-PNG (RGB, 8 bit) mit vorgegebenem Filter je Zeile; CRC wird vom Decoder nicht geprüft. */
async function encodePng(w: number, h: number, rgb: Uint8Array, filters: number[]): Promise<Uint8Array> {
  const stride = w * 3;
  const raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const f = filters[y % filters.length];
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const x = rgb[y * stride + i];
      const a = i >= 3 ? rgb[y * stride + i - 3] : 0;
      const b = y > 0 ? rgb[(y - 1) * stride + i] : 0;
      const c = i >= 3 && y > 0 ? rgb[(y - 1) * stride + i - 3] : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      raw[y * (stride + 1) + 1 + i] = (x - pred) & 255;
    }
  }
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    new DataView(out.buffer).setUint32(0, body.length);
    out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
    out.set(body, 8);
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w);
  new DataView(ihdr.buffer).setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  // IDAT in zwei Teile geteilt, wie bei großen Bildern üblich
  const half = z.length >> 1;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', z.subarray(0, half)), chunk('IDAT', z.subarray(half)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('decodePng', () => {
  it('decodes all five row filters exactly', async () => {
    const w = 7;
    const h = 10;
    const rgb = new Uint8Array(w * h * 3).map((_, i) => (i * 37 + (i >> 3) * 101) & 255);
    const png = await decodePng(await encodePng(w, h, rgb, [0, 1, 2, 3, 4]));
    expect(png).not.toBeNull();
    expect(png!.width).toBe(w);
    for (let i = 0; i < w * h; i++) {
      expect([png!.rgba[i * 4], png!.rgba[i * 4 + 1], png!.rgba[i * 4 + 2], png!.rgba[i * 4 + 3]]).toEqual([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 255]);
    }
  });

  it('rejects non-PNG data', async () => {
    expect(await decodePng(new Uint8Array(32))).toBeNull();
  });
});
