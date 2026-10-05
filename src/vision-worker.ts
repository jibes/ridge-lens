/// <reference lib="webworker" />
// Bildabgleich im Hintergrund, damit die Anzeige flüssig bleibt.
import type { Camera } from './projection';
import { extractSkyline, matchSkyline, searchWindows, type MatchResult } from './vision';

export type VisionRequest =
  | { type: 'horizon'; horizon: Float32Array; azStep: number }
  | { type: 'frame'; id: number; pixels: Uint8ClampedArray; cols: number; rows: number; cam: Camera };

export interface VisionResponse {
  id: number;
  cam: Camera;
  match: MatchResult;
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
  self.postMessage({ id: msg.id, cam, match } satisfies VisionResponse);
};
