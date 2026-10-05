import type { Key, Lang } from './i18n';

export interface ComputeRequest {
  /** Laufende Nummer; Nachrichten älterer Anfragen verwirft der Hauptthread. */
  id: number;
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
  /** Bekanntheit, siehe PeakRaw.fame. */
  fame: number;
  /** Wie weit der Gipfel über die Silhouette daneben (±1,5°) hinausragt (Grad, ≥ 0). */
  relief: number;
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
  /** Fortschritt der Gipfelkacheln; weitere kommen per 'peaks'-Nachricht nach. */
  peakTiles: PeakTileProgress;
  /** Nicht geladene Höhenkacheln (Lücken im Panorama). */
  failedTiles: number;
  millis: number;
}

export interface PeakTileProgress {
  done: number;
  total: number;
  failed: number;
}

export type WorkerMessage = { id: number } & (
  | { type: 'progress'; key: Key; params?: Record<string, number> }
  | { type: 'result'; result: PanoramaResult }
  | { type: 'error'; key: Key; detail?: string }
  /** Nachgelieferte Gipfel einer weiteren Kachel. */
  | { type: 'peaks'; peaks: Peak[]; progress: PeakTileProgress; error: string | null }
);
