/// <reference lib="webworker" />
import { Dem, fetchTerrariumTile, metersPerPixel } from './dem';
import { bearing, distance, elevationAngle, type LatLon } from './geo';
import { castRay, extractRidges, linkRidges, observerGround, occlusionAngle, type RayOptions, type RidgePoint, type Sampler } from './panorama';
import { fetchPeaks } from './peaks';
import type { Key } from './i18n';
import type { ComputeRequest, PanoramaResult, Peak, WorkerMessage } from './protocol';

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

declare const self: DedicatedWorkerGlobalScope;
const post = (msg: WorkerMessage, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

self.onmessage = async (ev: MessageEvent<ComputeRequest>) => {
  try {
    const result = await compute(ev.data);
    post({ type: 'result', result }, [result.horizon.buffer, result.linePoints.buffer, result.lineOffsets.buffer]);
  } catch (e) {
    if (e instanceof KeyedError) post({ type: 'error', key: e.key });
    else post({ type: 'error', key: 'status.error', detail: e instanceof Error ? e.message : String(e) });
  }
};

async function compute(req: ComputeRequest): Promise<PanoramaResult> {
  const t0 = performance.now();
  const observer: LatLon = { lat: req.lat, lon: req.lon };
  const near = new Dem(NEAR_ZOOM);
  const far = new Dem(FAR_ZOOM);

  const peaksPromise = fetchPeaks(observer, req.radius).then(
    (p) => ({ peaks: p, error: null as string | null }),
    (e) => ({ peaks: [], error: e instanceof Error ? e.message : String(e) }),
  );

  const progress = (key: Key) => (done: number, total: number) => post({ type: 'progress', key, params: { done, total } });
  const nearLoad = await near.load(observer, NEAR_RADIUS, fetchTerrariumTile, progress('progress.tilesNear'));
  const farLoad = await far.load(observer, req.radius, fetchTerrariumTile, progress('progress.tilesFar'));
  const failed = nearLoad.failed + farLoad.failed;
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

  post({ type: 'progress', key: 'progress.peaks' });
  const { peaks: raw, error: peakError } = await peaksPromise;

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

  post({ type: 'progress', key: 'progress.ridges' });
  const nBins = Math.round(360 / AZ_STEP);
  const horizon = new Float32Array(nBins);
  const bins: RidgePoint[][] = [];
  const ray = { dists: [] as number[], angles: [] as number[] };
  for (let i = 0; i < nBins; i++) {
    castRay(sample, observer, h0, i * AZ_STEP, rayOpts, ray);
    const { ridges, horizon: hz } = extractRidges(ray.dists, ray.angles);
    bins.push(ridges);
    horizon[i] = hz;
  }
  const lines = linkRidges(bins, AZ_STEP);

  const peaks: Peak[] = [];
  for (const p of raw) {
    const dist = distance(observer, p);
    if (dist < 150 || dist > req.radius) continue;
    const demEle = sample(p.lat, p.lon, dist);
    // DEM glättet Gipfel; OSM-Höhe bevorzugen, außer sie ist offensichtlich falsch
    const useOsm = p.ele !== null && (Number.isNaN(demEle) || Math.abs(p.ele - demEle) < 400);
    const ele = useOsm ? p.ele! : demEle;
    if (Number.isNaN(ele)) continue;
    const az = bearing(observer, p);
    const angle = elevationAngle(h0, ele, dist);
    const occ = occlusionAngle(sample, observer, h0, az, dist, rayOpts);
    peaks.push({ id: p.id, name: p.name, names: p.names, lat: p.lat, lon: p.lon, ele, eleFromOsm: useOsm, dist, az, angle, visible: angle >= occ - 0.05 });
  }

  return {
    request: req,
    demElevation,
    h0,
    azStep: AZ_STEP,
    horizon,
    linePoints: lines.points,
    lineOffsets: lines.offsets,
    peaks,
    peakError,
    failedTiles: failed,
    millis: performance.now() - t0,
  };
}
