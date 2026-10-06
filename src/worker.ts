/// <reference lib="webworker" />
import { Dem, fetchTerrariumTile, metersPerPixel } from './dem';
import { bearing, deltaDeg, distance, elevationAngle, type LatLon } from './geo';
import { castRay, extractRidges, linkRidges, observerGround, occlusionAngle, pruneLines, type MercSampler, type RayOptions, type RidgePoint, type Sampler } from './panorama';
import { loadPeakTiles, tilesFor, type PeakRaw, type PeakTile } from './peaks';
import type { Key } from './i18n';
import type { ComputeRequest, PanoramaResult, Peak, PeakTileProgress, WorkerMessage } from './protocol';

/** Fehler mit Übersetzungsschlüssel; der Hauptthread formuliert die Meldung. */
class KeyedError extends Error {
  constructor(readonly key: Key) {
    super(key);
  }
}

const AZ_STEP = 0.1;
const NEAR_ZOOM = 12;
const FAR_ZOOM = 10;
const NEAR_RADIUS = 8000;

/** Wartezeit auf die eigene Gipfelkachel (Gipfelhöhe als Standorthöhe), danach ohne weiter. */
const FIRST_TILE_WAIT_MS = 8_000;
/** Halbe Breite des zuerst berechneten Sektors um die Blickrichtung (Grad). */
const SECTOR = 70;
/** Sichtweiten (m) für die Dunst-Silhouetten des Bildabgleichs. */
const HAZE_DISTS = [15_000, 35_000];

declare const self: DedicatedWorkerGlobalScope;
let currentId = 0;

self.onmessage = async (ev: MessageEvent<ComputeRequest>) => {
  const id = (currentId = ev.data.id);
  const post = (msg: WorkerMessage, transfer: Transferable[] = []) => self.postMessage(msg, transfer);
  try {
    await compute(ev.data, post);
  } catch (e) {
    if (e instanceof KeyedError) post({ id, type: 'error', key: e.key });
    else post({ id, type: 'error', key: 'status.error', detail: e instanceof Error ? e.message : String(e) });
  }
};

async function compute(req: ComputeRequest, post: (msg: WorkerMessage, transfer?: Transferable[]) => void): Promise<void> {
  const t0 = performance.now();
  const id = req.id;
  const observer: LatLon = { lat: req.lat, lon: req.lon };
  const near = new Dem(NEAR_ZOOM);
  const far = new Dem(FAR_ZOOM);

  // Gipfelkacheln laden parallel zum Höhenmodell; die erste ist die eigene
  const tiles = loadPeakTiles(observer, req.radius);
  const tileProgress: PeakTileProgress = { done: 0, total: tilesFor(observer, req.radius).length, failed: 0 };
  let peakError: string | null = null;
  const firstTile = tiles.next();

  const progress = (key: Key) => (done: number, total: number) => post({ id, type: 'progress', key, params: { done, total } });
  // Blickrichtung zuerst: ferne Kacheln im Sektor (plus Umgebung), der Rest nach dem ersten Ergebnis
  const inSector = (az: number, margin = 0) => Math.abs(deltaDeg(az, req.heading)) <= SECTOR + margin;
  const sectorTile = (corners: LatLon[]) =>
    corners.some((c) => distance(observer, c) < 20_000 || inSector(bearing(observer, c), 5));
  const nearLoad = await near.load(observer, NEAR_RADIUS, fetchTerrariumTile, progress('progress.tilesNear'));
  const farLoad = await far.load(observer, req.radius, fetchTerrariumTile, progress('progress.tilesFar'), sectorTile);
  if (farLoad.total > 0 && farLoad.failed === farLoad.total) {
    throw new KeyedError('error.noTiles');
  }

  const sample: Sampler = (lat, lon, d) => {
    if (d < NEAR_RADIUS) {
      const h = near.elevation(lat, lon);
      if (!Number.isNaN(h)) return h;
    }
    return far.elevation(lat, lon);
  };
  // Dasselbe in Mercator-Koordinaten für die Strahlen (heißer Pfad)
  const sampleMerc: MercSampler = (x, y, d) => {
    if (d < NEAR_RADIUS) {
      const h = near.elevationMerc(x, y);
      if (!Number.isNaN(h)) return h;
    }
    return far.elevationMerc(x, y);
  };

  post({ id, type: 'progress', key: 'progress.peaks' });
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), FIRST_TILE_WAIT_MS));
  const first = await Promise.race([firstTile, timeout]);
  const ownTile: PeakTile | null = first && !first.done ? first.value : null;
  const raw: PeakRaw[] = ownTile?.peaks ?? [];

  const demElevation = near.elevation(req.lat, req.lon);
  // Auf einem Gipfel (OSM-Gipfel < 80 m entfernt) dessen Höhe nehmen: das DEM liegt dort oft 30–60 m zu tief
  const summit = raw
    .filter((p) => p.ele !== null && distance(observer, p) < 80)
    .sort((a, b) => distance(observer, a) - distance(observer, b))[0];
  const terrain = observerGround(sample, observer);
  const ground = req.groundElevation ?? (summit ? Math.max(summit.ele!, terrain) : terrain);
  if (Number.isNaN(ground)) throw new KeyedError('error.noElevation');
  const h0 = ground + req.eyeHeight;

  const nearRes = metersPerPixel(req.lat, NEAR_ZOOM);
  const farRes = metersPerPixel(req.lat, FAR_ZOOM);
  const rayOpts: RayOptions = {
    minDist: 40,
    maxDist: req.radius,
    // Schrittweite wächst mit der Distanz, höchstens eine DEM-Zelle
    step: (d) => Math.max(10, Math.min(d * 0.01, d < NEAR_RADIUS ? nearRes : farRes)),
  };

  const nBins = Math.round(360 / AZ_STEP);
  const horizon = new Float32Array(nBins).fill(NaN);
  // Silhouette nur bis zu einer Entfernung: ferne Gipfel verschwinden im Dunst
  const hazeHorizons = HAZE_DISTS.map((dist) => ({ dist, horizon: new Float32Array(nBins).fill(NaN) }));
  const bins: RidgePoint[][] = Array.from({ length: nBins }, () => []);
  const ray = { dists: [] as number[], angles: [] as number[] };
  let doneRays = 0;
  const castBins = (pick: (az: number) => boolean) => {
    for (let i = 0; i < nBins; i++) {
      if (!pick(i * AZ_STEP)) continue;
      if (++doneRays % 360 === 0) post({ id, type: 'progress', key: 'progress.ridges', params: { pct: Math.round((100 * doneRays) / nBins) } });
      castRay(sampleMerc, observer, h0, i * AZ_STEP, rayOpts, ray);
      const { ridges, horizon: hz } = extractRidges(ray.dists, ray.angles);
      bins[i] = ridges;
      horizon[i] = hz;
      for (const band of hazeHorizons) {
        let max = -90;
        for (let k = 0; k < ray.dists.length && ray.dists[k] <= band.dist; k++) max = Math.max(max, ray.angles[k]);
        band.horizon[i] = max;
      }
    }
  };
  // Lücken überbrücken, kurze Stücke (Rauschen in der Ferne) verwerfen
  const link = () => pruneLines(linkRidges(bins, AZ_STEP), horizon, AZ_STEP);

  /** Lage, Höhe und Sichtbarkeit je Gipfel (Hervortreten berechnet der Hauptthread aus der Silhouette). */
  const process = (list: PeakRaw[]): Peak[] => {
    const out: Peak[] = [];
    for (const p of list) {
      const dist = distance(observer, p);
      if (dist < 150 || dist > req.radius) continue;
      const demEle = sample(p.lat, p.lon, dist);
      // DEM glättet Gipfel; OSM-Höhe bevorzugen, außer sie ist offensichtlich falsch
      const useOsm = p.ele !== null && (Number.isNaN(demEle) || Math.abs(p.ele - demEle) < 400);
      const ele = useOsm ? p.ele! : demEle;
      if (Number.isNaN(ele)) continue;
      const az = bearing(observer, p);
      const angle = elevationAngle(h0, ele, dist);
      const occ = occlusionAngle(sampleMerc, observer, h0, az, dist, rayOpts);
      const visible = angle >= occ - 0.05;
      out.push({ id: p.id, name: p.name, names: p.names, lat: p.lat, lon: p.lon, ele, eleFromOsm: useOsm, fame: p.fame, dist, az, angle, visible, relief: 0 });
    }
    return out;
  };
  const count = (tile: PeakTile) => {
    tileProgress.done++;
    if (tile.error) {
      tileProgress.failed++;
      peakError = tile.error;
    }
  };

  // 1. Sektor um die Blickrichtung
  post({ id, type: 'progress', key: 'progress.ridges', params: { pct: 0 } });
  castBins((az) => inSector(az));
  const lines = link();
  if (ownTile) count(ownTile);
  const sectorPeaks = raw.filter((p) => inSector(bearing(observer, p)));
  const result: PanoramaResult = {
    request: req,
    demElevation,
    h0,
    azStep: AZ_STEP,
    horizon: horizon.slice(),
    hazeHorizons: hazeHorizons.map((b) => ({ dist: b.dist, horizon: b.horizon.slice() })),
    complete: false,
    linePoints: lines.points,
    lineOffsets: lines.offsets,
    peaks: process(sectorPeaks),
    peakError,
    peakTiles: { ...tileProgress },
    failedTiles: nearLoad.failed + farLoad.failed,
    millis: performance.now() - t0,
  };
  post({ id, type: 'result', result }, [result.horizon.buffer, result.linePoints.buffer, result.lineOffsets.buffer]);

  // 2. Restliche Kacheln und Strahlen, dann volle Silhouette und übrige Gipfel der eigenen Kachel
  await far.load(observer, req.radius, fetchTerrariumTile);
  if (id !== currentId) return;
  castBins((az) => !inSector(az));
  const all = link();
  const full = horizon.slice();
  const haze = hazeHorizons.map((b) => ({ dist: b.dist, horizon: b.horizon.slice() }));
  post({ id, type: 'horizon', horizon: full, hazeHorizons: haze, linePoints: all.points, lineOffsets: all.offsets }, [
    full.buffer,
    ...haze.map((b) => b.horizon.buffer),
    all.points.buffer,
    all.offsets.buffer,
  ]);
  const rest = raw.filter((p) => !inSector(bearing(observer, p)));
  if (rest.length) post({ id, type: 'peaks', peaks: process(rest), progress: { ...tileProgress }, error: peakError });

  // Übrige Kacheln nachliefern, solange keine neue Anfrage läuft
  let next = ownTile ? tiles.next() : firstTile;
  for (let r = await next; !r.done; r = await next) {
    if (id !== currentId) {
      await tiles.return();
      return;
    }
    count(r.value);
    post({ id, type: 'peaks', peaks: process(r.value.peaks), progress: { ...tileProgress }, error: peakError });
    next = tiles.next();
  }
}
