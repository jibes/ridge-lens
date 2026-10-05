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
  name: string;
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
  peakError: string | null;
  millis: number;
}

export type WorkerMessage =
  | { type: 'progress'; text: string }
  | { type: 'result'; result: PanoramaResult }
  | { type: 'error'; message: string };
