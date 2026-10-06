/// <reference lib="webworker" />
// Bildabgleich im Hintergrund, damit die Anzeige flüssig bleibt.
import type { Camera } from './projection';
import { detectBody, extractSkyline, matchPitch, matchSkylineHaze, searchWindows, type BodyTarget, type MatchResult } from './vision';

export type VisionRequest =
  | { type: 'horizon'; horizon: Float32Array; haze: Float32Array[]; azStep: number }
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
let haze: Float32Array[] = [];
let azStep = 0.1;

self.onmessage = (ev: MessageEvent<VisionRequest>) => {
  const msg = ev.data;
  if (msg.type === 'horizon') {
    horizon = msg.horizon;
    haze = msg.haze;
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
  const match = matchSkylineHaze(points, [horizon, ...haze], azStep, cam, cols);
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
    const skyPoints: { x: number; y: number }[] = [];
    for (let c = 0; c < cols; c++) {
      if (sky.blueSky[c]) skyPoints.push({ x: ((c + 0.5) * cam.width) / cols, y: (sky.y[c] * cam.height) / rows });
    }
    // Je Modell-Silhouette (Dunst); widersprechen sich gültige Lösungen, keine Korrektur
    const pitches = [horizon, ...haze].map((h) => matchPitch(skyPoints, h, azStep, cam, cols)).filter((m) => m.ok);
    const pitch = pitches.sort((a, b) => a.cost - b.cost)[0];
    if (pitch && pitches.every((m) => Math.abs(m.dPitch - pitch.dPitch) < 0.3)) {
      self.postMessage({ id: msg.id, cam, match: pitch, source: 'pitch' } satisfies VisionResponse);
      return;
    }
  }
  self.postMessage({ id: msg.id, cam, match, source: 'skyline' } satisfies VisionResponse);
};
