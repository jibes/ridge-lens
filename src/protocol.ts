import type { Key, Lang } from './i18n';

export interface ComputeRequest {
  lat: number;
  lon: number;
  /** Sichtweite in Metern. */
  radius: number;
  /** Augenhöhe über Boden (m). */
  eyeHeight: number;
  /** Bodenhöhe des Standorts (m); null = aus dem Höhenmodell. */
  groundElevation: number | null;
}

export interface Peak {
  id: number;
  /** Ortsüblicher Name (OSM `name`). */
  name: string;
  /** Übersetzte Namen (OSM `name:xx`), falls vorhanden. */
  names: Partial<Record<Lang, string>>;
  lat: number;
  lon: number;
  ele: number;
  eleFromOsm: boolean;
  dist: number;
  az: number;
  angle: number;
  visible: boolean;
}

export interface PanoramaResult {
  request: ComputeRequest;
  /** Bodenhöhe laut Höhenmodell (m). */
  demElevation: number;
  /** Verwendete Augenhöhe über Meer (m). */
  h0: number;
  azStep: number;
  /** Höhenwinkel der Silhouette je Azimut-Bin. */
  horizon: Float32Array;
  linePoints: Float32Array;
  lineOffsets: Uint32Array;
  peaks: Peak[];
  /** Technische Fehlerdetails der Gipfelabfrage (Server, HTTP-Status), sprachneutral. */
  peakError: string | null;
  /** Nicht geladene Höhenkacheln (Lücken im Panorama). */
  failedTiles: number;
  millis: number;
}

export type WorkerMessage =
  | { type: 'progress'; key: Key; params?: Record<string, number> }
  | { type: 'result'; result: PanoramaResult }
  | { type: 'error'; key: Key; detail?: string };
