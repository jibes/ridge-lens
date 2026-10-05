import { normalizeDeg } from './geo';
import type { Camera } from './projection';
import type { ComputeRequest, PanoramaResult, WorkerMessage } from './protocol';
import { renderOverview, renderView, type PlacedLabel } from './render';

interface Preset {
  name: string;
  lat: number;
  lon: number;
  ele: number;
  heading: number;
}

const PRESETS: Preset[] = [
  { name: 'Rigi Kulm', lat: 47.0566, lon: 8.4851, ele: 1797, heading: 180 },
  { name: 'Pilatus Kulm', lat: 46.979, lon: 8.2552, ele: 2106, heading: 150 },
  { name: 'Säntis', lat: 47.2494, lon: 9.3434, ele: 2502, heading: 200 },
  { name: 'Niesen', lat: 46.6456, lon: 7.6515, ele: 2362, heading: 120 },
  { name: 'Gornergrat', lat: 45.9834, lon: 7.7848, ele: 3089, heading: 230 },
  { name: 'Zugspitze', lat: 47.4211, lon: 10.9853, ele: 2962, heading: 180 },
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('form');
const latIn = $<HTMLInputElement>('lat');
const lonIn = $<HTMLInputElement>('lon');
const eleIn = $<HTMLInputElement>('ele');
const radiusIn = $<HTMLInputElement>('radius');
const presetSel = $<HTMLSelectElement>('preset');
const hiddenIn = $<HTMLInputElement>('hidden');
const statusEl = $<HTMLDivElement>('status');
const view = $<HTMLCanvasElement>('view');
const overview = $<HTMLCanvasElement>('overview');
const viewCtx = view.getContext('2d')!;
const overCtx = overview.getContext('2d')!;

const cam: Camera = { heading: 180, pitch: 2, hfov: 60, width: 0, height: 0 };
let pano: PanoramaResult | null = null;
let labels: PlacedLabel[] = [];
let busy = false;

for (const [i, p] of PRESETS.entries()) presetSel.add(new Option(p.name, String(i)));

// --- Zustand in URL: #lat,lon,ele,heading,fov ---------------------------------

function writeHash() {
  const ele = eleIn.value ? Number(eleIn.value) : '';
  const h = [latIn.value, lonIn.value, ele, Math.round(cam.heading), Math.round(cam.hfov)].join(',');
  history.replaceState(null, '', `#${h}`);
}

function readHash(): boolean {
  const parts = location.hash.slice(1).split(',');
  if (parts.length < 2 || !parts[0] || !parts[1]) return false;
  latIn.value = parts[0];
  lonIn.value = parts[1];
  eleIn.value = parts[2] ?? '';
  if (parts[3]) cam.heading = normalizeDeg(Number(parts[3]));
  if (parts[4]) cam.hfov = clampFov(Number(parts[4]));
  return true;
}

function applyPreset(p: Preset) {
  latIn.value = String(p.lat);
  lonIn.value = String(p.lon);
  eleIn.value = String(p.ele);
  cam.heading = p.heading;
}

// --- Rendering ------------------------------------------------------------------

let frame = 0;
function requestRender() {
  if (!frame) frame = requestAnimationFrame(render);
}

function render() {
  frame = 0;
  const dpr = devicePixelRatio || 1;
  viewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  labels = renderView(viewCtx, cam, pano, { showHidden: hiddenIn.checked });
  const ow = overview.clientWidth;
  overCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderOverview(overCtx, ow, overview.clientHeight, cam, pano);
}

function resize() {
  const dpr = devicePixelRatio || 1;
  cam.width = view.clientWidth;
  cam.height = view.clientHeight;
  view.width = Math.round(cam.width * dpr);
  view.height = Math.round(cam.height * dpr);
  overview.width = Math.round(overview.clientWidth * dpr);
  overview.height = Math.round(overview.clientHeight * dpr);
  requestRender();
}
new ResizeObserver(resize).observe(view);

// --- Berechnung -------------------------------------------------------------------

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
  const msg = ev.data;
  if (msg.type === 'progress') {
    statusEl.textContent = msg.text;
    return;
  }
  busy = false;
  if (msg.type === 'error') {
    statusEl.textContent = `Fehler: ${msg.message}`;
    return;
  }
  pano = msg.result;
  const visible = pano.peaks.filter((p) => p.visible).length;
  statusEl.textContent =
    `Augenhöhe ${Math.round(pano.h0)} m (DEM ${Math.round(pano.demElevation)} m) · ` +
    `${visible}/${pano.peaks.length} Gipfel sichtbar · ${(pano.millis / 1000).toFixed(1)} s` +
    (pano.peakError ? ` · ${pano.peakError}` : '');
  requestRender();
};

function compute() {
  if (busy) return;
  const lat = Number(latIn.value);
  const lon = Number(lonIn.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85) {
    statusEl.textContent = 'Ungültige Koordinaten';
    return;
  }
  const req: ComputeRequest = {
    lat,
    lon,
    radius: Math.min(250, Math.max(10, Number(radiusIn.value) || 100)) * 1000,
    eyeHeight: 1.7,
    groundElevation: eleIn.value ? Number(eleIn.value) : null,
  };
  busy = true;
  statusEl.textContent = 'Starte …';
  writeHash();
  worker.postMessage(req);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  compute();
});
presetSel.addEventListener('change', () => {
  const p = PRESETS[Number(presetSel.value)];
  if (presetSel.value && p) {
    applyPreset(p);
    compute();
  }
});
for (const el of [latIn, lonIn, eleIn]) el.addEventListener('input', () => (presetSel.value = ''));
hiddenIn.addEventListener('change', requestRender);

$<HTMLButtonElement>('gps').addEventListener('click', () => {
  if (!navigator.geolocation) {
    statusEl.textContent = 'Kein GPS verfügbar';
    return;
  }
  statusEl.textContent = 'Bestimme Standort …';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      latIn.value = pos.coords.latitude.toFixed(5);
      lonIn.value = pos.coords.longitude.toFixed(5);
      // GPS-Höhe nur bei guter Genauigkeit, sonst Höhenmodell
      const alt = pos.coords.altitude;
      const acc = pos.coords.altitudeAccuracy;
      eleIn.value = alt !== null && acc !== null && acc < 15 ? alt.toFixed(0) : '';
      presetSel.value = '';
      compute();
    },
    (err) => (statusEl.textContent = `GPS-Fehler: ${err.message}`),
    { enableHighAccuracy: true, timeout: 20000 },
  );
});

// --- Interaktion: Drehen, Neigen, Zoomen --------------------------------------------

function clampFov(f: number) {
  return Math.min(100, Math.max(5, f));
}

const pointers = new Map<number, { x: number; y: number }>();
let pinchDist = 0;

view.addEventListener('pointerdown', (e) => {
  view.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  view.style.cursor = 'grabbing';
});
view.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) {
    updateHover(e);
    return;
  }
  if (pointers.size === 2) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist) cam.hfov = clampFov((cam.hfov * pinchDist) / d);
    pinchDist = d;
  } else {
    const k = cam.hfov / cam.width;
    cam.heading = normalizeDeg(cam.heading - (e.clientX - prev.x) * k);
    cam.pitch = Math.max(-30, Math.min(30, cam.pitch + (e.clientY - prev.y) * k));
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }
  requestRender();
});
const endPointer = (e: PointerEvent) => {
  pointers.delete(e.pointerId);
  pinchDist = 0;
  view.style.cursor = 'grab';
  writeHash();
};
view.addEventListener('pointerup', endPointer);
view.addEventListener('pointercancel', endPointer);

view.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    cam.hfov = clampFov(cam.hfov * Math.exp(e.deltaY * 0.001));
    requestRender();
    writeHash();
  },
  { passive: false },
);

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const step = e.shiftKey ? 10 : 1;
  if (e.key === 'ArrowLeft') cam.heading = normalizeDeg(cam.heading - step);
  else if (e.key === 'ArrowRight') cam.heading = normalizeDeg(cam.heading + step);
  else if (e.key === 'ArrowUp') cam.pitch = Math.min(30, cam.pitch + step * 0.5);
  else if (e.key === 'ArrowDown') cam.pitch = Math.max(-30, cam.pitch - step * 0.5);
  else if (e.key === '+') cam.hfov = clampFov(cam.hfov / 1.2);
  else if (e.key === '-') cam.hfov = clampFov(cam.hfov * 1.2);
  else return;
  requestRender();
  writeHash();
});

overview.addEventListener('click', (e) => {
  const r = overview.getBoundingClientRect();
  cam.heading = normalizeDeg(((e.clientX - r.left) / r.width) * 360);
  requestRender();
  writeHash();
});

/** Tooltip mit Details zum nächsten Gipfel-Label. */
function updateHover(e: PointerEvent) {
  const r = view.getBoundingClientRect();
  const x = e.clientX - r.left;
  const hit = labels.find((l) => Math.abs(l.x - x) < 7);
  view.title = hit
    ? `${hit.peak.name}\n${Math.round(hit.peak.ele)} m${hit.peak.eleFromOsm ? '' : ' (DEM)'} · ` +
      `${(hit.peak.dist / 1000).toFixed(1)} km · Azimut ${hit.peak.az.toFixed(1)}° · ` +
      `Höhenwinkel ${hit.peak.angle.toFixed(2)}°${hit.peak.visible ? '' : ' · verdeckt'}`
    : '';
}

window.addEventListener('hashchange', () => {
  if (readHash()) {
    presetSel.value = '';
    compute();
    requestRender();
  }
});

// --- Start ------------------------------------------------------------------------

if (!readHash()) {
  applyPreset(PRESETS[0]);
  presetSel.value = '0';
}
resize();
compute();
