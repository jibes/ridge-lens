/**
 * Trainingsdaten für ein eigenes Horizont-Modell, nur lokal (IndexedDB): Horizontstreifen
 * als JPEG plus die aus dem Höhenmodell projizierte Silhouette bei sicher bekannter
 * Ausrichtung. Export als ZIP über das Teilen-Menü.
 */

export interface TrainMeta {
  /** Zeitpunkt (ms seit 1970). */
  t: number;
  lat: number;
  lon: number;
  /** Augenhöhe über Meer (m). */
  h0: number;
  /** Ausrichtung, für die die Silhouette gilt (korrigiert). */
  cam: { heading: number; pitch: number; roll: number; hfov: number; width: number; height: number };
  /** Streifen in Ansichtspixeln [oben, unten]; Bild w×h deckt ihn in voller Breite ab. */
  band: [number, number];
  w: number;
  h: number;
  /** Silhouette je Bildspalte (Zeile im Streifen, null = außerhalb): voll, Gelände bis 15 km, bis 35 km. */
  lines: { full: (number | null)[]; h15: (number | null)[]; h35: (number | null)[] };
  /** Woher die Ausrichtung stammt (skyline, tower, sun, pano, manual) und Restfehler. */
  source: string;
  cost: number;
  /** Horizontlinie der aktuellen KI (zum Vergleich), falls vorhanden. */
  ai?: (number | null)[];
}

const DB = 'ridge-lens-train';
const STORE = 'samples';
export const MAX_SAMPLES = 1500;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const r = fn(db.transaction(STORE, mode).objectStore(STORE));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      }),
  );
}

export const countSamples = () => tx('readonly', (s) => s.count());
export const clearSamples = () => tx('readwrite', (s) => s.clear()).then(() => undefined);

export async function addSample(meta: TrainMeta, jpeg: Blob): Promise<number> {
  if ((await countSamples()) >= MAX_SAMPLES) throw new Error('full');
  await tx('readwrite', (s) => s.add({ meta, jpeg }));
  return countSamples();
}

export async function allSamples(): Promise<{ meta: TrainMeta; jpeg: Blob }[]> {
  return tx('readonly', (s) => s.getAll() as IDBRequest<{ meta: TrainMeta; jpeg: Blob }[]>);
}
