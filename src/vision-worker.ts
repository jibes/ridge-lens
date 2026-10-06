/// <reference lib="webworker" />
// Bildabgleich im Hintergrund, damit die Anzeige flüssig bleibt.
import type { Camera } from './projection';
import { detectBody, extractSkyline, matchPitch, matchSkyline, searchWindows, type BodyTarget, type MatchResult } from './vision';

export type VisionRequest =
  | { type: 'horizon'; horizon: Float32Array; azStep: number }
  | { type: 'frame'; id: number; pixels: Uint8ClampedArray; cols: number; rows: number; cam: Camera; bodies: BodyTarget[] };

export interface VisionResponse {
  id: number;
  cam: Camera;
  match: MatchResult;
  /** Woran ausgerichtet wurde; Sonne/Mond liefern keinen Bildwinkel. */
  source: 'skyline' | 'pitch' | BodyTarget['kind'];
}

declare const self: DedicatedWorkerGlobalScope;
let horizon: Float32Array | null = null;
let azStep = 0.1;

self.onmessage = (ev: MessageEvent<VisionRequest>) => {
  const msg = ev.data;
  if (msg.type === 'horizon') {
    horizon = msg.horizon;
    azStep = msg.azStep;
    return;
  }
  if (!horizon) return;
  const { pixels, cols, rows, cam } = msg;
  const windows = searchWindows(cam, horizon, azStep, cols, rows);
  const sky = extractSkyline(pixels, cols, rows, windows);
  const points: { x: number; y: number }[] = [];
  for (let c = 0; c < cols; c++) {
    if (!Number.isNaN(sky.y[c])) points.push({ x: ((c + 0.5) * cam.width) / cols, y: (sky.y[c] * cam.height) / rows });
  }
  const match = matchSkyline(points, horizon, azStep, cam, cols);
  if (!match.ok) {
    // Ohne brauchbare Silhouette: Sonne bzw. Mond als Fixpunkt
    for (const body of msg.bodies) {
      const m = detectBody(pixels, cols, rows, cam, body, horizon, azStep);
      if (m.ok) {
        self.postMessage({ id: msg.id, cam, match: m, source: body.kind } satisfies VisionResponse);
        return;
      }
    }
    // Silhouette nur teilweise frei (Bäume) oder zu flach für den Kurs: wenigstens die Neigung
    const pitch = matchPitch(points, horizon, azStep, cam, cols);
    if (pitch.ok) {
      self.postMessage({ id: msg.id, cam, match: pitch, source: 'pitch' } satisfies VisionResponse);
      return;
    }
  }
  self.postMessage({ id: msg.id, cam, match, source: 'skyline' } satisfies VisionResponse);
};
