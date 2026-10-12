/**
 * Himmelserkennung mit TinySkyNet (49 k Parameter, MIT, siehe public/models/LICENSE-TinySkyNet.txt):
 * schlanke eigene Inferenz für die vier Operationen des Netzes (Faltung, ReLU, bilineare
 * Vergrößerung, Verketten) statt einer 10-MB-Laufzeit. Eingabe 256×256 RGB, Ausgabe 128×128
 * Wahrscheinlichkeiten „Himmel“.
 */

interface Node {
  op: 'Conv' | 'Relu' | 'Resize' | 'Concat';
  in: string[];
  out: string;
  w?: string;
  b?: string | null;
  group?: number;
  stride?: number;
  pad?: number;
  k?: number;
}

export interface SkyNetModel {
  input: string;
  output: string;
  nodes: Node[];
  weights: Record<string, { offset: number; shape: number[] }>;
}

interface Tensor {
  c: number;
  h: number;
  w: number;
  data: Float32Array;
}

export const SKYNET_SIZE = 256;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export class SkyNet {
  constructor(
    private model: SkyNetModel,
    private params: Float32Array,
  ) {}

  private weight(name: string): Float32Array {
    const w = this.model.weights[name];
    const n = w.shape.reduce((a, b) => a * b, 1);
    return this.params.subarray(w.offset, w.offset + n);
  }

  /**
   * Bild (RGBA, beliebige Größe w×h) → Himmelswahrscheinlichkeit 128×128. Das Bild wird wie
   * im Training auf 256×256 gestaucht (Flächenmittel bzw. nächster Punkt).
   */
  segment(rgba: Uint8ClampedArray, w: number, h: number): { size: number; prob: Float32Array } {
    const S = SKYNET_SIZE;
    const input = new Float32Array(3 * S * S);
    for (let y = 0; y < S; y++) {
      const y0 = Math.floor((y * h) / S);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / S));
      for (let x = 0; x < S; x++) {
        const x0 = Math.floor((x * w) / S);
        const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / S));
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const p = (yy * w + xx) * 4;
            r += rgba[p];
            g += rgba[p + 1];
            b += rgba[p + 2];
            n++;
          }
        }
        const i = y * S + x;
        input[i] = (r / n / 255 - MEAN[0]) / STD[0];
        input[i + S * S] = (g / n / 255 - MEAN[1]) / STD[1];
        input[i + 2 * S * S] = (b / n / 255 - MEAN[2]) / STD[2];
      }
    }
    const out = this.run({ c: 3, h: S, w: S, data: input });
    const prob = new Float32Array(out.data.length);
    for (let i = 0; i < prob.length; i++) prob[i] = 1 / (1 + Math.exp(-out.data[i]));
    return { size: out.w, prob };
  }

  run(x: Tensor): Tensor {
    const vals = new Map<string, Tensor>([[this.model.input, x]]);
    for (const n of this.model.nodes) {
      const a = vals.get(n.in[0])!;
      let r: Tensor;
      if (n.op === 'Conv') r = this.conv(a, n);
      else if (n.op === 'Relu') r = relu(a);
      else if (n.op === 'Resize') r = upsample2(a);
      else r = concat(n.in.map((k) => vals.get(k)!));
      vals.set(n.out, r);
    }
    return vals.get(this.model.output)!;
  }

  private conv(x: Tensor, n: Node): Tensor {
    const W = this.weight(n.w!);
    const B = n.b ? this.weight(n.b) : null;
    const [co, ciPerG, k] = this.model.weights[n.w!].shape;
    const g = n.group ?? 1;
    const s = n.stride ?? 1;
    const p = n.pad ?? 0;
    const oh = Math.floor((x.h + 2 * p - k) / s) + 1;
    const ow = Math.floor((x.w + 2 * p - k) / s) + 1;
    const out = new Float32Array(co * oh * ow);
    for (let oc = 0; oc < co; oc++) out.fill(B ? B[oc] : 0, oc * oh * ow, (oc + 1) * oh * ow);
    if (k === 1 && s === 1 && g === 1) pointwise(x.data, out, W, co, ciPerG, oh * ow);
    else spatial(x, out, W, co, ciPerG, co / g, k, s, p, oh, ow);
    return { c: co, h: oh, w: ow, data: out };
  }
}

/** 1×1-Faltung, vier Eingangskanäle je Durchlauf (spart Speicherzugriffe auf die Ausgabe). */
function pointwise(d: Float32Array, out: Float32Array, W: Float32Array, co: number, ci: number, plane: number) {
  for (let oc = 0; oc < co; oc++) {
    const ob = oc * plane;
    const wb = oc * ci;
    let ic = 0;
    for (; ic + 4 <= ci; ic += 4) {
      const w0 = W[wb + ic];
      const w1 = W[wb + ic + 1];
      const w2 = W[wb + ic + 2];
      const w3 = W[wb + ic + 3];
      const s0 = ic * plane;
      const s1 = s0 + plane;
      const s2 = s1 + plane;
      const s3 = s2 + plane;
      for (let i = 0; i < plane; i++) out[ob + i] += w0 * d[s0 + i] + w1 * d[s1 + i] + w2 * d[s2 + i] + w3 * d[s3 + i];
    }
    for (; ic < ci; ic++) {
      const w0 = W[wb + ic];
      const s0 = ic * plane;
      for (let i = 0; i < plane; i++) out[ob + i] += w0 * d[s0 + i];
    }
  }
}

/** k×k-Faltung (auch gruppiert/tiefenweise); Randprüfung nur je Zeile bzw. über den gültigen x-Bereich. */
function spatial(
  x: Tensor,
  out: Float32Array,
  W: Float32Array,
  co: number,
  ciPerG: number,
  coPerG: number,
  k: number,
  s: number,
  p: number,
  oh: number,
  ow: number,
) {
  const d = x.data;
  const ih = x.h;
  const iw = x.w;
  for (let oc = 0; oc < co; oc++) {
    const ob = oc * oh * ow;
    const gi = Math.floor(oc / coPerG);
    for (let ic = 0; ic < ciPerG; ic++) {
      const sb = (gi * ciPerG + ic) * ih * iw;
      const wBase = (oc * ciPerG + ic) * k * k;
      for (let ky = 0; ky < k; ky++) {
        for (let kx = 0; kx < k; kx++) {
          const wv = W[wBase + ky * k + kx];
          // gültige Ausgabespalten: 0 ≤ xo*s + kx - p < iw
          const xa = Math.max(0, Math.ceil((p - kx) / s));
          const xb = Math.min(ow, Math.floor((iw - 1 + p - kx) / s) + 1);
          for (let y = 0; y < oh; y++) {
            const iy = y * s + ky - p;
            if (iy < 0 || iy >= ih) continue;
            const row = sb + iy * iw + kx - p;
            const orow = ob + y * ow;
            if (s === 1) for (let xo = xa; xo < xb; xo++) out[orow + xo] += wv * d[row + xo];
            else for (let xo = xa; xo < xb; xo++) out[orow + xo] += wv * d[row + xo * s];
          }
        }
      }
    }
  }
}

function relu(x: Tensor): Tensor {
  const d = x.data;
  for (let i = 0; i < d.length; i++) if (d[i] < 0) d[i] = 0;
  return x;
}

/** Bilineare Vergrößerung ×2 (ONNX Resize, linear, half_pixel). */
function upsample2(x: Tensor): Tensor {
  const oh = x.h * 2;
  const ow = x.w * 2;
  const out = new Float32Array(x.c * oh * ow);
  for (let c = 0; c < x.c; c++) {
    const src = x.data.subarray(c * x.h * x.w);
    const dst = out.subarray(c * oh * ow);
    for (let y = 0; y < oh; y++) {
      const fy = Math.max(0, (y + 0.5) / 2 - 0.5);
      const y0 = Math.floor(fy);
      const y1 = Math.min(x.h - 1, y0 + 1);
      const wy = fy - y0;
      for (let xo = 0; xo < ow; xo++) {
        const fx = Math.max(0, (xo + 0.5) / 2 - 0.5);
        const x0 = Math.floor(fx);
        const x1 = Math.min(x.w - 1, x0 + 1);
        const wx = fx - x0;
        const top = src[y0 * x.w + x0] * (1 - wx) + src[y0 * x.w + x1] * wx;
        const bot = src[y1 * x.w + x0] * (1 - wx) + src[y1 * x.w + x1] * wx;
        dst[y * ow + xo] = top * (1 - wy) + bot * wy;
      }
    }
  }
  return { c: x.c, h: oh, w: ow, data: out };
}

function concat(xs: Tensor[]): Tensor {
  const c = xs.reduce((a, t) => a + t.c, 0);
  const out = new Float32Array(c * xs[0].h * xs[0].w);
  let off = 0;
  for (const t of xs) {
    out.set(t.data, off);
    off += t.data.length;
  }
  return { c, h: xs[0].h, w: xs[0].w, data: out };
}

/**
 * Kontrast je Farbkanal auf 1.–99. Perzentil strecken (in place): hebt Berge im Dunst vom
 * Himmel ab. Am Feldbild (Zürichsee) erkannte das Netz die Voralpen erst damit.
 */
export function stretchContrast(rgba: Uint8ClampedArray): void {
  const n = rgba.length / 4;
  for (let k = 0; k < 3; k++) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[rgba[i * 4 + k]]++;
    let lo = 0;
    let hi = 255;
    for (let acc = 0; lo < 255 && (acc += hist[lo]) < n * 0.01; lo++);
    for (let acc = 0; hi > 0 && (acc += hist[hi]) < n * 0.01; hi--);
    if (hi - lo < 8) continue;
    const s = 255 / (hi - lo);
    for (let i = 0; i < n; i++) rgba[i * 4 + k] = (rgba[i * 4 + k] - lo) * s;
  }
}
