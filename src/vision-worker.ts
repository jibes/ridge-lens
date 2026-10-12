/// <reference lib="webworker" />
// Bildabgleich im Hintergrund, damit die Anzeige flüssig bleibt.
import type { Camera } from './projection';
import { SkyNet, SKYNET_SIZE, type SkyNetModel } from './skynet';
import { SkylineAccumulator, treeTolerance, detectBody, detectStars, matchStars, type StarRef, extractSkyline, extractSkylineSeg, matchPitch, matchSkylineHaze, searchWindows, type BodyTarget, type MatchResult } from './vision';

export type VisionRequest =
  | { type: 'horizon'; horizon: Float32Array; haze: Float32Array[]; azStep: number; dist: Float32Array; hazeDist: Float32Array[] }
  | {
      type: 'frame';
      id: number;
      pixels: Uint8ClampedArray;
      cols: number;
      rows: number;
      cam: Camera;
      bodies: BodyTarget[];
      /** Korrekturen, die in `cam` stecken (für das Rundumprofil herausgerechnet). */
      offHeading: number;
      offPitch: number;
      /** Gerät wird geschwenkt: Bild nur fürs Rundumprofil sammeln. */
      moving: boolean;
      /** Nachts: Bild in höherer Auflösung (Sterne sind punktförmig) und Sterne/Planeten im Blickfeld. */
      stars?: { pixels: Uint8ClampedArray; cols: number; rows: number; refs: StarRef[] };
      /** Tagsüber: derselbe Ausschnitt auf SKYNET_SIZE² gestaucht, für die Himmelserkennung. */
      seg?: Uint8ClampedArray;
    };

export interface VisionResponse {
  id: number;
  cam: Camera;
  match: MatchResult;
  /** Woran ausgerichtet wurde; Sonne/Mond liefern keinen Bildwinkel. */
  source: 'skyline' | 'pitch' | 'pano' | 'stars' | BodyTarget['kind'];
  /** Himmelserkennung lief (ms), sonst Farbkanten. */
  segMs?: number;
}

declare const self: DedicatedWorkerGlobalScope;
let horizon: Float32Array | null = null;
let haze: Float32Array[] = [];
/** Waldtoleranz je Modell (volle Silhouette, dann Dunst-Silhouetten). */
let tols: Float32Array[] = [];
let azStep = 0.1;
const acc = new SkylineAccumulator();

/** Himmelserkennung, beim ersten Tagbild nachgeladen; schlägt das fehl, bleibt es bei den Farbkanten. */
let net: SkyNet | null = null;
let netState: 'idle' | 'loading' | 'failed' = 'idle';
function loadNet() {
  netState = 'loading';
  const url = (f: string) => new URL(`../models/${f}`, import.meta.url);
  Promise.all([fetch(url('skynet.json')).then((r) => r.json()), fetch(url('skynet.bin')).then((r) => r.arrayBuffer())])
    .then(([model, bin]: [SkyNetModel, ArrayBuffer]) => {
      net = new SkyNet(model, new Float32Array(bin));
    })
    .catch(() => {
      netState = 'failed';
    });
}

self.onmessage = (ev: MessageEvent<VisionRequest>) => {
  const msg = ev.data;
  if (msg.type === 'horizon') {
    horizon = msg.horizon;
    haze = msg.haze;
    tols = [treeTolerance(msg.dist), ...msg.hazeDist.map((d) => treeTolerance(d))];
    azStep = msg.azStep;
    acc.clear();
    return;
  }
  if (!horizon) return;
  const { pixels, cols, rows, cam } = msg;
  const windows = searchWindows(cam, horizon, azStep, cols, rows);
  let sky = null;
  let segMs: number | undefined;
  if (msg.seg) {
    if (net) {
      const t0 = performance.now();
      const mask = net.segment(msg.seg, SKYNET_SIZE, SKYNET_SIZE);
      sky = extractSkylineSeg(pixels, cols, rows, windows, mask.prob, mask.size);
      segMs = performance.now() - t0;
    } else if (netState === 'idle') loadNet();
  }
  sky ??= extractSkyline(pixels, cols, rows, windows);
  const points: { x: number; y: number }[] = [];
  for (let c = 0; c < cols; c++) {
    if (!Number.isNaN(sky.y[c])) points.push({ x: ((c + 0.5) * cam.width) / cols, y: (sky.y[c] * cam.height) / rows });
  }
  const skyPoints: { x: number; y: number }[] = [];
  for (let c = 0; c < cols; c++) {
    if (sky.blueSky[c]) skyPoints.push({ x: ((c + 0.5) * cam.width) / cols, y: (sky.y[c] * cam.height) / rows });
  }
  const now = performance.now();
  acc.add(skyPoints, cam, msg.offHeading, msg.offPitch, now);
  const none: MatchResult = { ok: false, dHeading: 0, dPitch: 0, fovScale: 1, cost: Infinity };
  if (msg.moving) {
    self.postMessage({ id: msg.id, cam, match: none, source: 'skyline', segMs } satisfies VisionResponse);
    return;
  }
  const match = matchSkylineHaze(points, [horizon, ...haze], azStep, cam, cols, tols);
  if (!match.ok && msg.stars) {
    // Nachts: Sternmuster
    const st = msg.stars;
    const m = matchStars(detectStars(st.pixels, st.cols, st.rows, cam, horizon, azStep), st.refs);
    if (m.ok) {
      self.postMessage({ id: msg.id, cam, match: m, source: 'stars' } satisfies VisionResponse);
      return;
    }
  }
  if (!match.ok) {
    // Ohne brauchbare Silhouette: Sonne bzw. Mond als Fixpunkt
    for (const body of msg.bodies) {
      const m = detectBody(pixels, cols, rows, cam, body, horizon, azStep);
      if (m.ok) {
        self.postMessage({ id: msg.id, cam, match: m, source: body.kind } satisfies VisionResponse);
        return;
      }
    }
    // Einzelbild zu verdeckt oder zu flach: Rundumprofil aus den letzten Bildern
    const pano = acc.match([horizon, ...haze], azStep, now);
    if (pano.ok) {
      const m: MatchResult = { ok: true, dHeading: pano.heading - msg.offHeading, dPitch: pano.pitch - msg.offPitch, fovScale: 1, cost: pano.cost };
      self.postMessage({ id: msg.id, cam, match: m, source: 'pano', segMs } satisfies VisionResponse);
      return;
    }
    // Sonst wenigstens die Neigung
    // Je Modell-Silhouette (Dunst); widersprechen sich gültige Lösungen, keine Korrektur
    const pitches = [horizon, ...haze].map((h) => matchPitch(skyPoints, h, azStep, cam, cols)).filter((m) => m.ok);
    const pitch = pitches.sort((a, b) => a.cost - b.cost)[0];
    if (pitch && pitches.every((m) => Math.abs(m.dPitch - pitch.dPitch) < 0.3)) {
      self.postMessage({ id: msg.id, cam, match: pitch, source: 'pitch', segMs } satisfies VisionResponse);
      return;
    }
  }
  self.postMessage({ id: msg.id, cam, match, source: 'skyline', segMs } satisfies VisionResponse);
};
