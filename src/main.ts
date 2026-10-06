import { deltaDeg, normalizeDeg } from './geo';
import { OrientationTracker } from './orientation';
import { decimalYear, declination as magneticDeclination } from './magnetic';
import { prefetchArea } from './offline';
import type { SatInfo, SatPass } from './sats';
import { dayTrack } from './tracks';
import { azimuthInView, projector, type Camera } from './projection';
import type { ComputeRequest, PanoramaResult, Peak, WorkerMessage } from './protocol';
import { applyDom, compassLabels, detectLang, lang, setLang, storedLangChoice, storeLangChoice, t, type Lang } from './i18n';
import { CameraFeed, DEFAULT_CAMERA_FOV, displayHfov, fitTilt, fovLongFromDisplay, type TiltSample } from './camera';
import type { VisionRequest, VisionResponse } from './vision-worker';
import type { BodyTarget, MatchResult, StarRef } from './vision';
import { CAMERA, DARK, LIGHT, renderOverview, renderView, turnToTarget, type PlacedLabel, type SkyBody } from './render';
import { bodyPath, moonPosition, sunPosition, terrainEvents, type PathPoint } from './astro';
import { buildNightSky, prepareSky, type NightSky, type PreparedSky, type SkyData } from './nightsky';
import { fold, nameScore, scorePeaks } from './search';
import { skylineRelief } from './panorama';

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
// Ungültige Koordinaten sitzen im eingeklappten Bereich: aufklappen, damit der Browser sie zeigen kann
form.addEventListener('invalid', () => ($<HTMLDetailsElement>('manual').open = true), true);
const latIn = $<HTMLInputElement>('lat');
const lonIn = $<HTMLInputElement>('lon');
const eleIn = $<HTMLInputElement>('ele');
const radiusIn = $<HTMLInputElement>('radius');
const presetSel = $<HTMLSelectElement>('preset');
const hiddenIn = $<HTMLInputElement>('hidden');
const statusEl = $<HTMLDivElement>('status');
// Antippen zeigt lange Meldungen vollständig
statusEl.addEventListener('click', () => {
  statusEl.classList.toggle('expanded');
  requestRender();
});

/**
 * Statuszeile = aktueller Zustand + dauerhafte Hinweise (GPS, Sensor).
 * Texte als Funktionen, damit ein Sprachwechsel sie neu formuliert.
 */
type Text = () => string;
let baseStatus: Text = () => '';
const notices = new Map<string, Text>();
function setStatus(text: Text) {
  baseStatus = text;
  statusEl.textContent = [baseStatus(), ...[...notices.values()].map((n) => n())].filter(Boolean).join(' · ');
  // Hinweise dürfen umbrechen, normale Statusmeldungen bleiben einzeilig
  statusEl.classList.toggle('wrap', notices.size > 0);
}
function setNotice(key: string, text: Text | null) {
  if (text) notices.set(key, text);
  else notices.delete(key);
  setStatus(baseStatus);
}

/** Anzeigename eines Gipfels in der gewählten Sprache, sonst ortsüblich. */
function peakName(p: Peak): string {
  return p.names[lang()] ?? p.name;
}
const view = $<HTMLCanvasElement>('view');
const overview = $<HTMLCanvasElement>('overview');
const alignBar = $<HTMLDivElement>('align');
const alignText = $<HTMLSpanElement>('align-text');
const alignApply = $<HTMLButtonElement>('align-apply');
const sensorInfo = $<HTMLDivElement>('sensor-info');
const sensorText = $<HTMLSpanElement>('sensor-text');
const viewCtx = view.getContext('2d')!;
const overCtx = overview.getContext('2d')!;

// Standard-Sichtfeld: Hochformat schmaler, damit Gipfel nicht winzig wirken
const cam: Camera = { heading: 180, pitch: 2, roll: 0, hfov: innerWidth < innerHeight ? 35 : 45, width: 0, height: 0 };
let pano: PanoramaResult | null = null;
let labels: PlacedLabel[] = [];
let busy = false;
let selected: Peak | null = null;
/** Angetipptes Himmelsobjekt (statt eines Gipfels): 'sun', 'moon', 'planet:…', 'star:…'. */
let selectedSky: string | null = null;
/** Gesuchter Gipfel (Id, bleibt über Neuberechnungen erhalten). */
let targetId: number | null = null;
/** Gesuchter Himmelskörper (Schlüssel wie 'sun', 'planet:mars', 'star:Sirius', 'con:Ori'). */
let targetSky: string | null = null;

// Sensormodus: Blick folgt dem Gerät; Ziehen/Anpeilen korrigiert den Kompass
const tracker = new OrientationTracker(() => {
  if (!sensorOn) {
    sensorOn = true;
    setNotice('sensor', null);
    applySensorUi();
  }
  requestRender();
});
let sensorOn = false;
let manualCal = false;
const OFFSET_KEY = 'ridge-lens-offset';
/** Ältere Korrekturen (ohne `v: 2`) enthalten die Missweisung noch; wird beim ersten Standort abgezogen. */
let legacyOffset = false;
const offset = loadOffset();
/** Magnetische Missweisung am Standort (Grad, Ost positiv). */
let declination = 0;
/**
 * Manuelle Korrektur (Ziehen, Übernehmen, Zoomen) getrennt von der automatischen am
 * Bild: wird zurückgesetzt, sobald der manuelle Modus aus ist.
 */
const MANUAL_ADJ_KEY = 'ridge-lens-manual-adj';
const manualAdj = loadManualAdj();
function loadManualAdj(): { heading: number; pitch: number; fov: number } {
  try {
    const o = JSON.parse(localStorage.getItem(MANUAL_ADJ_KEY) ?? '');
    if (Number.isFinite(o.heading) && Number.isFinite(o.pitch) && o.fov > 0) return o;
  } catch {
    /* keine */
  }
  return { heading: 0, pitch: 0, fov: 1 };
}
function saveManualAdj() {
  try {
    localStorage.setItem(MANUAL_ADJ_KEY, JSON.stringify(manualAdj));
  } catch {
    /* kein Speicher */
  }
}
/** Gesamtkorrektur (automatisch + manuell). */
const totalHeadingOffset = () => deltaDeg(offset.heading + manualAdj.heading, 0);
const totalPitchOffset = () => offset.pitch + manualAdj.pitch;

function loadOffset(): { heading: number; pitch: number } {
  try {
    const o = JSON.parse(localStorage.getItem(OFFSET_KEY) ?? '');
    if (Number.isFinite(o.heading) && Number.isFinite(o.pitch)) {
      legacyOffset = o.v !== 2 && o.heading !== 0;
      return { heading: o.heading, pitch: o.pitch };
    }
  } catch {
    /* kein gespeicherter Offset */
  }
  return { heading: 0, pitch: 0 };
}

/** Woher eine Korrektur kam (für das Protokoll in den Sensordetails). */
type OffsetSource = 'drag' | 'apply' | 'legacy' | 'reset' | 'fov' | VisionResponse['source'];
const corrLog: { t: number; src: OffsetSource; dh: number; dp: number; h: number; p: number }[] = [];
let loggedOffset = { heading: totalHeadingOffset(), pitch: totalPitchOffset() };

function saveOffset(src: OffsetSource) {
  const cur = { heading: totalHeadingOffset(), pitch: totalPitchOffset() };
  const dh = deltaDeg(cur.heading, loggedOffset.heading);
  const dp = cur.pitch - loggedOffset.pitch;
  if (Math.abs(dh) >= 0.05 || Math.abs(dp) >= 0.05) {
    const now = Date.now();
    const last = corrLog[corrLog.length - 1];
    // Gleiche Quelle kurz hintereinander zusammenfassen
    if (last && last.src === src && now - last.t < 10_000) {
      last.dh += dh;
      last.dp += dp;
      last.t = now;
      last.h = cur.heading;
      last.p = cur.pitch;
    } else {
      corrLog.push({ t: now, src, dh, dp, h: cur.heading, p: cur.pitch });
      if (corrLog.length > 8) corrLog.shift();
    }
    loggedOffset = cur;
  }
  saveManualAdj();
  try {
    localStorage.setItem(OFFSET_KEY, JSON.stringify({ ...offset, v: 2 }));
  } catch {
    /* privater Modus o. ä. */
  }
}

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
  syncSensor();
  syncTarget();
  syncCameraFov();
  updateNoise();
  const dpr = devicePixelRatio || 1;
  const overlay = cameraShown();
  // Nachts dunkles Schema auch bei hellem System, sonst leuchten Labels auf dem Nachthimmel
  const palette = overlay ? CAMERA : darkScheme.matches || (night?.fade ?? 0) > 0.5 ? DARK : LIGHT;
  // Nachts Bedienelemente und Overlay dämpfen (blendet nicht, Augen bleiben dunkeladaptiert)
  document.body.classList.toggle('night-ui', (night?.fade ?? 0) > 0.5);
  viewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  labels = renderView(viewCtx, cam, pano, {
    palette,
    showHidden: hiddenIn.checked,
    showTerrain: showTerrainIn.checked,
    showSky: showSkyIn.checked,
    // Fadenkreuz nur zum manuellen Kalibrieren (Gipfel anpeilen, übernehmen)
    crosshair: sensorOn && manualCal,
    selectedPeakId: selected?.id ?? null,
    targetPeakId: targetId,
    target: targetPoint(),
    bottomInset: view.getBoundingClientRect().bottom - (targetChip.hidden ? dockEl : targetChip).getBoundingClientRect().top + 8,
    peakName,
    compass: compassLabels(8),
    sky: visibleSky(),
    sats: shownSats(),
    night,
    // Skala und Labels unterhalb der Statuszeile beginnen
    topInset: statusEl.getBoundingClientRect().bottom - view.getBoundingClientRect().top,
    overlay,
  });
  if (overview.clientWidth) {
    overCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const targetAz = targetPoint()?.az ?? null;
    renderOverview(overCtx, overview.clientWidth, overview.clientHeight, cam, pano, palette, compassLabels(8), targetAz);
  }
}

const darkScheme = matchMedia('(prefers-color-scheme: dark)');
darkScheme.addEventListener('change', requestRender);

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
const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(view);
resizeObserver.observe(overview);

// --- Berechnung -------------------------------------------------------------------

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let requestId = 0;

/** Statuszeile nach der Berechnung; zählt nachgelieferte Gipfel mit. */
function showResultStatus(result: PanoramaResult) {
  setStatus(() => {
    const { done, total, failed } = result.peakTiles;
    return [
      t('status.result', { ele: Math.round(result.h0), count: result.peaks.filter((p) => p.visible).length }),
      done < total ? t('status.peakTiles', { done, total }) : '',
      result.failedTiles ? t('status.tilesMissing', { n: result.failedTiles }) : '',
      failed ? t('status.peakTilesFailed', { n: failed }) : '',
      failed && result.peakError ? t('error.peaks', { detail: result.peakError }) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  });
}

/** Startbildschirm ausblenden (nach erstem Ergebnis oder Fehler, spätestens nach 10 s). */
const splash = document.getElementById('splash');
/** Splash nur kurz: weg, sobald gerechnet wird (frühestens 0,6 s), spätestens nach 2,5 s – Fortschritt zeigt die Statuszeile. */
const splashSince = performance.now();
function hideSplash() {
  if (!splash || splash.classList.contains('done')) return;
  const wait = 600 - (performance.now() - splashSince);
  if (wait > 0) {
    setTimeout(hideSplash, wait);
    return;
  }
  splash.classList.add('done');
  setTimeout(() => splash.remove(), 500);
}
setTimeout(hideSplash, 2500);

worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
  const msg = ev.data;
  hideSplash();
  // Nachzügler einer früheren Berechnung (anderer Standort) verwerfen
  if (msg.id !== requestId) return;
  if (msg.type === 'peaks') {
    if (!pano) return;
    applyRelief(pano, msg.peaks);
    pano.peaks.push(...msg.peaks);
    pano.peakTiles = msg.progress;
    pano.peakError = msg.error;
    showResultStatus(pano);
    requestRender();
    return;
  }
  if (msg.type === 'progress') {
    // Nach dem ersten Sektor rechnet der Rest still weiter; Statuszeile bleibt beim Ergebnis
    if (pano?.request.id !== msg.id) setStatus(() => t(msg.key, msg.params));
    return;
  }
  if (msg.type === 'horizon') {
    // Volle Silhouette nach dem ersten Sektor
    if (!pano) return;
    pano.horizon = msg.horizon;
    pano.hazeHorizons = msg.hazeHorizons;
    pano.linePoints = msg.linePoints;
    pano.lineOffsets = msg.lineOffsets;
    pano.complete = true;
    applyRelief(pano, pano.peaks);
    showResultStatus(pano);
    updateSky();
    requestRender();
    return;
  }
  busy = false;
  if (msg.type === 'error') {
    setStatus(() => (msg.detail ? t('status.error', { msg: msg.detail }) : t(msg.key)));
    return;
  }
  pano = msg.result;
  applyRelief(pano, pano.peaks);
  selected = null;
  updateAlignBar();
  showResultStatus(pano);
  updateSky();
  requestRender();
};

/** Hervortreten über die Silhouette (für die Label-Rangfolge); 0, solange die Silhouette dort fehlt. */
function applyRelief(p: PanoramaResult, peaks: Peak[]) {
  for (const peak of peaks) {
    const r = peak.visible ? skylineRelief(p.horizon, p.azStep, peak.az, peak.angle) : 0;
    peak.relief = Number.isFinite(r) ? r : 0;
  }
}

function compute() {
  if (busy) return;
  const lat = Number(latIn.value);
  const lon = Number(lonIn.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85) {
    setStatus(() => t('status.invalidCoords'));
    return;
  }
  const req: ComputeRequest = {
    id: ++requestId,
    lat,
    lon,
    radius: Math.min(250, Math.max(10, Number(radiusIn.value) || 100)) * 1000,
    eyeHeight: 1.7,
    groundElevation: eleIn.value ? Number(eleIn.value) : null,
    heading: cam.heading,
  };
  busy = true;
  setStatus(() => t('status.start'));
  writeHash();
  updateDeclination(lat, lon);
  updateSky();
  worker.postMessage(req);
}

// --- Einstellungsblatt -----------------------------------------------------------

const panel = $<HTMLElement>('panel');
const menuBtn = $<HTMLButtonElement>('menu');
function setPanel(open: boolean) {
  panel.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
}
menuBtn.addEventListener('click', () => setPanel(panel.hidden !== false));
$<HTMLButtonElement>('panel-close').addEventListener('click', () => setPanel(false));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    setPanel(false);
    setSearch(false);
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  setPanel(false);
  compute();
});
presetSel.addEventListener('change', () => {
  const p = PRESETS[Number(presetSel.value)];
  if (presetSel.value && p) {
    applyPreset(p);
    setPanel(false);
    compute();
  }
});
for (const el of [latIn, lonIn, eleIn]) el.addEventListener('input', () => (presetSel.value = ''));
hiddenIn.addEventListener('change', requestRender);

/** Ebenen-Menü über der Bedienleiste: aufklappen, Ebenen umschalten; Tippen daneben schließt. */
const layersMenu = $<HTMLDivElement>('layers-menu');
const layersOpen = $<HTMLButtonElement>('layers-open');
function setLayersMenu(open: boolean) {
  layersMenu.hidden = !open;
  layersOpen.setAttribute('aria-expanded', String(open));
}
layersOpen.addEventListener('click', (e) => {
  e.stopPropagation();
  setLayersMenu(layersMenu.hidden === true);
});
document.addEventListener('pointerdown', (e) => {
  if (!layersMenu.hidden && !layersMenu.contains(e.target as Node) && !layersOpen.contains(e.target as Node)) setLayersMenu(false);
});

/** Ebenen ein-/ausblenden (der Bildabgleich nutzt sie weiter). */
const showTerrainIn = $<HTMLInputElement>('show-terrain');
const showSkyIn = $<HTMLInputElement>('show-sky');
for (const [el, key] of [
  [showTerrainIn, 'ridge-lens-show-terrain'],
  [showSkyIn, 'ridge-lens-show-sky'],
] as const) {
  try {
    el.checked = localStorage.getItem(key) !== 'off';
  } catch {
    /* kein Speicher */
  }
  const btn = $<HTMLButtonElement>(el === showTerrainIn ? 'layer-terrain' : 'layer-sky');
  btn.setAttribute('aria-pressed', String(el.checked));
  btn.addEventListener('click', () => {
    el.checked = !el.checked;
    el.dispatchEvent(new Event('change'));
  });
  el.addEventListener('change', () => {
    btn.setAttribute('aria-pressed', String(el.checked));
    if (el === showSkyIn && el.checked) void loadSats();
    try {
      localStorage.setItem(key, el.checked ? 'on' : 'off');
    } catch {
      /* kein Speicher */
    }
    if (!el.checked) {
      if (el === showTerrainIn) selected = null;
      else selectedSky = null;
      updateAlignBar();
    }
    requestRender();
  });
}

/** Standort per GPS in die Eingabefelder; liefert Fehlertext oder null. */
function locate(): Promise<Text | null> {
  if (!navigator.geolocation) return Promise.resolve(() => t('gps.unavailable'));
  setStatus(() => t('status.locating'));
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        latIn.value = pos.coords.latitude.toFixed(5);
        lonIn.value = pos.coords.longitude.toFixed(5);
        // GPS-Höhe ist ellipsoidisch (CH ≈ 50 m über Meereshöhe) → Höhenmodell verwenden
        eleIn.value = '';
        presetSel.value = '';
        resolve(null);
      },
      (err) => resolve(err.code === err.PERMISSION_DENIED ? () => t('gps.denied') : () => err.message || t('gps.error')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    ),
  );
}

$<HTMLButtonElement>('gps').addEventListener('click', async () => {
  const err = await locate();
  setNotice('gps', err && (() => `GPS: ${err()}`));
  if (!err) compute();
});

// --- Interaktion: Drehen, Neigen, Zoomen --------------------------------------------

function clampFov(f: number) {
  return Math.min(100, Math.max(5, f));
}

/**
 * Zoom: ohne Kamera das Sichtfeld; mit Kamerabild ist das Sichtfeld durch die Kamera
 * vorgegeben, dann kalibriert die Geste den Bildwinkel (bis Gipfel und Linien passen).
 */
function zoomBy(factor: number) {
  if (cameraShown()) {
    // Bildwinkel kalibriert sich am Bild; von Hand nur im manuellen Modus
    if (!manualCal) return;
    manualAdj.fov = Math.min(2, Math.max(0.5, manualAdj.fov * factor));
    saveManualAdj();
  } else {
    cam.hfov = clampFov(cam.hfov * factor);
  }
}

/** Blick drehen/neigen; im Sensormodus wird stattdessen die Korrektur verschoben. */
function rotateBy(dHeading: number, dPitch: number) {
  if (sensorOn) {
    if (!manualCal) return;
    manualAdj.heading = deltaDeg(manualAdj.heading + dHeading, 0);
    manualAdj.pitch = Math.max(-20, Math.min(20, manualAdj.pitch + dPitch));
    saveOffset('drag');
  } else {
    cam.heading = normalizeDeg(cam.heading + dHeading);
    cam.pitch = Math.max(-30, Math.min(30, cam.pitch + dPitch));
  }
}

const pointers = new Map<number, { x: number; y: number }>();
let pinchDist = 0;
let downAt: { x: number; y: number; moved: boolean } | null = null;

view.addEventListener('pointerdown', (e) => {
  view.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  downAt = pointers.size === 1 ? { x: e.clientX, y: e.clientY, moved: false } : null;
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
    if (pinchDist) zoomBy(pinchDist / d);
    pinchDist = d;
  } else {
    if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) downAt.moved = true;
    if (downAt && !downAt.moved) return;
    const k = cam.hfov / cam.width;
    rotateBy(-(e.clientX - prev.x) * k, (e.clientY - prev.y) * k);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }
  requestRender();
});
const endPointer = (e: PointerEvent) => {
  if (e.type === 'pointerup' && downAt && !downAt.moved && pointers.size === 1) selectAt(e);
  downAt = null;
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
    zoomBy(Math.exp(e.deltaY * 0.001));
    requestRender();
    writeHash();
  },
  { passive: false },
);

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const step = e.shiftKey ? 10 : sensorOn ? 0.2 : 1;
  if (e.key === 'ArrowLeft') rotateBy(-step, 0);
  else if (e.key === 'ArrowRight') rotateBy(step, 0);
  else if (e.key === 'ArrowUp') rotateBy(0, step * 0.5);
  else if (e.key === 'ArrowDown') rotateBy(0, -step * 0.5);
  else if (e.key === '+') zoomBy(1 / 1.2);
  else if (e.key === '-') zoomBy(1.2);
  else return;
  requestRender();
  writeHash();
});

overview.addEventListener('click', (e) => {
  if (sensorOn) return;
  const r = overview.getBoundingClientRect();
  cam.heading = normalizeDeg(((e.clientX - r.left) / r.width) * 360);
  requestRender();
  writeHash();
});

function labelAt(e: PointerEvent, tolerance: number): PlacedLabel | undefined {
  const x = e.clientX - view.getBoundingClientRect().left;
  let best: PlacedLabel | undefined;
  for (const l of labels) {
    if (Math.abs(l.x - x) < tolerance && (!best || Math.abs(l.x - x) < Math.abs(best.x - x))) best = l;
  }
  return best;
}

function peakDetails(p: Peak): string {
  return (
    `${Math.round(p.ele)} m${p.eleFromOsm ? '' : ` (${t('peak.dem')})`} · ${(p.dist / 1000).toFixed(1)} km · ` +
    `${t('peak.azimuth')} ${p.az.toFixed(1)}° · ${t('peak.elevationAngle')} ${p.angle.toFixed(2)}°` +
    (p.visible ? '' : ` · ${t('peak.hidden')}`)
  );
}

/** Tooltip mit Details zum nächsten Gipfel-Label. */
function updateHover(e: PointerEvent) {
  const hit = labelAt(e, 7);
  view.title = hit ? `${peakName(hit.peak)}\n${peakDetails(hit.peak)}` : '';
}

/** Antippen eines Labels wählt den Gipfel, Antippen von Sonne/Mond den Himmelskörper (für Anpeilen/Zentrieren). */
function selectAt(e: PointerEvent) {
  const obj = skyObjectAt(e);
  if (obj) {
    selectedSky = obj === selectedSky ? null : obj;
    selected = null;
  } else {
    const hit = labelAt(e, 14);
    selected = hit && hit.peak.id !== selected?.id ? hit.peak : null;
    selectedSky = null;
  }
  updateAlignBar();
  requestRender();
}

/** Gewählter Gipfel oder Himmelskörper: Name, Richtung und Details. */
function selection(): { name: string; az: number; angle: number; details: string } | null {
  if (selected) return { name: peakName(selected), az: selected.az, angle: selected.angle, details: peakDetails(selected) };
  const o = tappableSky().find((x) => x.key === selectedSky);
  return o ? { name: o.name, az: o.az, angle: o.alt, details: skyDetails(o.key) } : null;
}

function updateAlignBar() {
  const sel = selection();
  alignBar.hidden = !sel;
  if (!sel) return;
  // Mit Sensoren nur im manuellen Modus "Übernehmen" anbieten, sonst bloß Infos
  const calibrate = sensorOn && manualCal;
  alignText.textContent = calibrate ? t('align.instruction', { name: sel.name }) : `${sel.name} · ${sel.details}`;
  alignApply.hidden = sensorOn && !manualCal;
  alignApply.textContent = t(calibrate ? 'align.apply' : 'align.center');
}

alignApply.addEventListener('click', () => {
  const sel = selection();
  if (!sel) return;
  const a = tracker.angles;
  if (sensorOn && a) {
    // Korrektur so, dass Gipfel bzw. Sonne/Mond genau im Fadenkreuz liegen
    manualAdj.heading = deltaDeg(sel.az, trueHeading(a.heading) + offset.heading);
    manualAdj.pitch = Math.max(-20, Math.min(20, sel.angle - a.pitch - offset.pitch));
    saveOffset('apply');
    const correction = fmtSigned(manualAdj.heading);
    setStatus(() => t('align.done', { name: sel.name, offset: correction }));
  } else if (!sensorOn) {
    cam.heading = sel.az;
    cam.pitch = Math.max(-30, Math.min(30, sel.angle));
    writeHash();
  }
  selected = null;
  selectedSky = null;
  updateAlignBar();
  requestRender();
});
$<HTMLButtonElement>('align-close').addEventListener('click', () => {
  selected = null;
  selectedSky = null;
  updateAlignBar();
  requestRender();
});

// --- Sonne und Mond --------------------------------------------------------------

let sky: SkyBody[] = [];
let skyEvents: Record<'sun' | 'moon', { rise: number | null; set: number | null }> | null = null;
const skyInfo = $<HTMLParagraphElement>('sky-info');

/** Lage jetzt, Tagesbahnen und Auf-/Untergang über dem Gelände am aktuellen Standort. */
function updateSky() {
  const lat = pano?.request.lat ?? Number(latIn.value);
  const lon = pano?.request.lon ?? Number(lonIn.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const now = new Date(skyTime ?? Date.now());
  const start = new Date(now).setHours(0, 0, 0, 0);
  const end = start + 86_400_000;
  const sun = sunPosition(now, lat, lon);
  const moon = moonPosition(now, lat, lon);
  sky = [
    { kind: 'sun', az: sun.az, alt: sun.alt, path: bodyPath(sunPosition, lat, lon, start, end, 10) },
    { kind: 'moon', az: moon.az, alt: moon.alt, fraction: moon.fraction, sunAz: sun.az, sunAlt: sun.alt, path: bodyPath(moonPosition, lat, lon, start, end, 10) },
  ];
  const p = pano;
  const horizonAt = (az: number) => (p ? p.horizon[Math.round(az / p.azStep) % p.horizon.length] : 0);
  skyEvents = {
    sun: terrainEvents(bodyPath(sunPosition, lat, lon, start, end, 2), horizonAt),
    moon: terrainEvents(bodyPath(moonPosition, lat, lon, start, end, 2), horizonAt),
  };
  updateNight();
  showSkyInfo();
}
window.setInterval(updateSky, 60_000);

// --- Sterne, Sternbilder, Planeten ---------------------------------------------------

/** Gewählter Zeitpunkt für den Himmel (null = jetzt). */
let skyTime: number | null = null;
let preparedSky: PreparedSky | null = null;
let night: NightSky | null = null;

fetch('./sky/sky.json')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((data: SkyData) => {
    preparedSky = prepareSky(data);
    updateNight();
  })
  .catch((err) => console.warn('Sterndaten:', err));

/** Sterne wandern 0,25°/min: Lage alle 10 s neu (Sonne/Mond-Bahnen bleiben minütlich). */
function updateNight() {
  const sun = sky.find((b) => b.kind === 'sun');
  const lat = pano?.request.lat ?? Number(latIn.value);
  const lon = pano?.request.lon ?? Number(lonIn.value);
  if (preparedSky && sun && Number.isFinite(lat) && Number.isFinite(lon)) {
    const date = new Date(skyTime ?? Date.now());
    // Sonnenhöhe zum selben Zeitpunkt (die Liste kann bis zu einer Minute alt sein)
    night = buildNightSky(preparedSky, date, lat, lon, lang(), sunPosition(date, lat, lon).alt, (id) => t(`planet.${id}`), t('sky.milkyWay'));
  }
  if (selectedSky) updateAlignBar();
  requestRender();
}
window.setInterval(() => {
  // Auch tagsüber, solange ein Himmelskörper gesucht ist (Planeten, Sterne wandern)
  if (((night && night.fade > 0) || targetSky !== null) && skyTime === null) updateNight();
}, 10_000);

/** Antippbare Himmelsobjekte über dem Gelände: Sonne, Mond, nachts Planeten und helle Sterne. */
function tappableSky(): { key: string; name: string; az: number; alt: number }[] {
  if (!showSkyIn.checked) return [];
  const out: { key: string; name: string; az: number; alt: number }[] = sky.map((b) => ({ key: b.kind, name: t(b.kind === 'sun' ? 'sky.sun' : 'sky.moon'), az: b.az, alt: b.alt }));
  if (night && night.fade > 0) {
    for (const o of night.objects) {
      if (o.mag > night.magLimit + (o.kind === 'planet' ? 1.5 : 0)) continue;
      out.push({ key: o.key, name: o.name, az: o.az, alt: o.alt });
    }
  }
  for (const s of shownSats()) out.push({ key: s.key, name: s.name, az: s.az, alt: s.alt });
  const p = pano;
  return out.filter((o) => !p || o.alt >= p.horizon[Math.round(o.az / p.azStep) % p.horizon.length]);
}

const skyTimeIn = $<HTMLInputElement>('sky-time');
/** Datum → Wert für datetime-local (Ortszeit). */
function toLocalInput(t: number): string {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}
skyTimeIn.value = toLocalInput(Date.now());
skyTimeIn.addEventListener('change', () => {
  const t = skyTimeIn.value ? new Date(skyTimeIn.value).getTime() : NaN;
  skyTime = Number.isFinite(t) ? t : null;
  updateSky();
});
$<HTMLButtonElement>('sky-now').addEventListener('click', () => {
  skyTime = null;
  skyTimeIn.value = toLocalInput(Date.now());
  updateSky();
});


/**
 * Bahnen zum Zeichnen: ohne gewählte Zeit nur der Rest des Tages (vergangene Stunden
 * würden z. B. abends die Morgenbahn quer über den Osthimmel legen); ganze Bahn bei
 * gewählter Zeit oder wenn Sonne/Mond angetippt ist.
 */
/** Sonne und Mond mit voller Tagesbahn; dazu die Bahn des gewählten bzw. gesuchten Objekts. */
function visibleSky(): SkyBody[] {
  const key = trackKey();
  if (!key) return sky;
  const path = key.startsWith('sat:') ? (satPass(key)?.path ?? []) : objectTrack(key);
  if (!path.length) return sky;
  return [...sky, { kind: 'track', az: 0, alt: 0, path, marks: key.startsWith('sat:') ? 'minute' : 'hour' }];
}

/** Objekt, dessen Bahn gezeigt wird: ausgewählt, sonst gesucht (Sonne/Mond haben ihre Bahn immer). */
function trackKey(): string | null {
  const k = selectedSky ?? targetSky;
  return k && k !== 'sun' && k !== 'moon' ? k : null;
}

/** Tagesbahn (0–24 Uhr) eines Planeten, Sterns, Sternbilds oder der Milchstraße; zwischengespeichert. */
const trackCache = new Map<string, PathPoint[]>();
function objectTrack(key: string): PathPoint[] {
  const lat = pano?.request.lat ?? Number(latIn.value);
  const lon = pano?.request.lon ?? Number(lonIn.value);
  const start = new Date(skyTime ?? Date.now()).setHours(0, 0, 0, 0);
  const id = `${key}|${start}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
  let path = trackCache.get(id);
  if (!path) {
    path = dayTrack(key, preparedSky?.data ?? null, lat, lon, start, start + 86_400_000, 5);
    if (trackCache.size > 50) trackCache.clear();
    trackCache.set(id, path);
  }
  return path;
}

/** Details zu einem Himmelsobjekt: Auf-/Untergang über dem Gelände, Lage, Helligkeit bzw. Überflug. */
function skyDetails(key: string): string {
  const body = sky.find((b) => b.kind === key);
  if (body) return bodyDetails(body);
  if (key.startsWith('sat:')) {
    const p = satPass(key);
    if (!p) return t('sat.noPass');
    return t('sat.pass', { from: fmtTime(p.rise), to: fmtTime(p.set), max: Math.round(p.maxAlt), vis: t(p.visible ? 'sat.visible' : 'sat.notVisible') });
  }
  const o = night?.objects.find((x) => x.key === key);
  const p = pano;
  const ev = terrainEvents(objectTrack(key), (az) => (p ? p.horizon[Math.round(az / p.azStep) % p.horizon.length] : 0));
  const now = o ? t('sky.objDetails', { alt: o.alt.toFixed(1), az: Math.round(o.az), mag: o.mag.toFixed(1) }) : '';
  return [t('sky.riseSet', { rise: fmtTime(ev.rise), set: fmtTime(ev.set) }), now].filter(Boolean).join(' · ');
}

// --- Satelliten ---------------------------------------------------------------------

type SatModule = typeof import('./sats');
let satMod: SatModule | null = null;
let satList: SatInfo[] = [];
let satNow: { key: string; name: string; major: boolean; az: number; alt: number; sunlit: boolean }[] = [];
let satLoading = false;

/** Bahnelemente (vom Workflow täglich, peaks/sats.json) und Rechenmodul erst bei Bedarf laden. */
async function loadSats() {
  if (satMod || satLoading) return;
  satLoading = true;
  try {
    const res = await fetch('./peaks/sats.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    satMod = await import('./sats');
    satList = satMod.parseSats(json);
    updateSats();
  } catch (err) {
    console.warn('Satelliten:', err);
  } finally {
    satLoading = false;
  }
}

function observerPos() {
  return { lat: pano?.request.lat ?? Number(latIn.value), lon: pano?.request.lon ?? Number(lonIn.value), h: pano?.h0 ?? 0 };
}

/** Lage aller Satelliten über dem Horizont (sekündlich; die ISS zieht bis 1°/s). */
function updateSats() {
  if (!satMod || !showSkyIn.checked) {
    satNow = [];
    return;
  }
  const { lat, lon, h } = observerPos();
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const date = new Date(skyTime ?? Date.now());
  const out: typeof satNow = [];
  for (const s of satList) {
    const l = satMod.satLook(s, date, lat, lon, h);
    if (l && l.alt > 0) out.push({ key: s.key, name: s.name, major: s.major, ...l });
  }
  satNow = out;
  if (out.length) requestRender();
}
window.setInterval(updateSats, 1000);

/** Gezeigte Satelliten: Raumstationen immer, andere nur mit bloßem Auge sichtbar, sowie der gewählte. */
function shownSats(): { key: string; name: string; az: number; alt: number; visible: boolean; label: boolean }[] {
  if (!showSkyIn.checked) return [];
  const sunAlt = sky.find((b) => b.kind === 'sun')?.alt ?? 0;
  const focus = (k: string) => k === selectedSky || k === targetSky;
  return satNow
    .map((s) => ({ key: s.key, name: s.name, az: s.az, alt: s.alt, visible: s.sunlit && sunAlt < -6, label: s.major || focus(s.key), major: s.major }))
    .filter((s) => s.major || s.visible || focus(s.key));
}

/** Laufender oder nächster Überflug, eine Minute zwischengespeichert. */
const passCache = new Map<string, { at: number; pass: SatPass | null }>();
function satPass(key: string): SatPass | null {
  const sat = satList.find((s) => s.key === key);
  if (!satMod || !sat) return null;
  const now = skyTime ?? Date.now();
  const hit = passCache.get(key);
  if (hit && Math.abs(now - hit.at) < 60_000 && (!hit.pass || hit.pass.set > now)) return hit.pass;
  const { lat, lon, h } = observerPos();
  const pass = satMod.nextPass(sat, now, lat, lon, h);
  passCache.set(key, { at: now, pass });
  return pass;
}

function fmtTime(t: number | null): string {
  return t === null ? '–' : new Date(t).toLocaleTimeString(lang(), { hour: '2-digit', minute: '2-digit' });
}

function showSkyInfo() {
  const moon = sky.find((b) => b.kind === 'moon');
  if (!skyEvents || !moon) return;
  skyInfo.hidden = false;
  const day = skyTime === null ? t('sky.today') : new Date(skyTime).toLocaleDateString(lang(), { weekday: 'short', day: 'numeric', month: 'numeric' });
  skyInfo.textContent = t('sky.info', {
    day,
    sunRise: fmtTime(skyEvents.sun.rise),
    sunSet: fmtTime(skyEvents.sun.set),
    moonRise: fmtTime(skyEvents.moon.rise),
    moonSet: fmtTime(skyEvents.moon.set),
    pct: Math.round((moon.fraction ?? 0) * 100),
  });
}

function bodyDetails(b: SkyBody): string {
  const ev = b.kind === 'track' ? undefined : skyEvents?.[b.kind];
  return (
    t('sky.details', { rise: fmtTime(ev?.rise ?? null), set: fmtTime(ev?.set ?? null), alt: b.alt.toFixed(1), az: Math.round(b.az) }) +
    (b.kind === 'moon' ? ` · ${t('sky.lit', { pct: Math.round((b.fraction ?? 0) * 100) })}` : '')
  );
}

/** Himmelsobjekt unter dem Finger (nächstes innerhalb der Toleranz), Schlüssel oder null. */
function skyObjectAt(e: PointerEvent): string | null {
  const rect = view.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const proj = projector(cam);
  const disc = Math.max(7, (0.266 * cam.width) / cam.hfov);
  let best: string | null = null;
  let bestD = Infinity;
  for (const o of tappableSky()) {
    const q = proj(o.az, o.alt);
    if (!q) continue;
    const d = Math.hypot(q[0] - x, q[1] - y);
    const tol = (o.key === 'sun' || o.key === 'moon' ? disc : 4) + 16;
    if (d <= tol && d < bestD) {
      best = o.key;
      bestD = d;
    }
  }
  return best;
}

// --- Suche ------------------------------------------------------------------------

const searchBox = $<HTMLElement>('search');
const searchBtn = $<HTMLButtonElement>('search-open');
const searchInput = $<HTMLInputElement>('search-input');
const searchResults = $<HTMLUListElement>('search-results');
const targetChip = $<HTMLDivElement>('target');
const targetText = $<HTMLSpanElement>('target-text');
const dockEl = document.querySelector<HTMLElement>('.dock')!;

function setSearch(open: boolean) {
  searchBox.hidden = !open;
  searchBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    setPanel(false);
    searchInput.value = '';
    showResults();
    searchInput.focus();
  }
}
searchBtn.addEventListener('click', () => setSearch(searchBox.hidden !== false));
$<HTMLButtonElement>('search-close').addEventListener('click', () => setSearch(false));
searchInput.addEventListener('input', showResults);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchResults.querySelector('button')?.click();
});

/** Durchsuchbare Himmelskörper: Sonne, Mond, Planeten, benannte Sterne, Sternbilder. */
interface SkyItem {
  key: string;
  name: string;
  names: string[];
  az: number;
  alt: number;
  kind: 'sun' | 'moon' | 'planet' | 'star' | 'deep' | 'constellation' | 'sat';
  /** Rang bei gleicher Übereinstimmung (heller = höher). */
  rank: number;
}
function skyItems(): SkyItem[] {
  const out: SkyItem[] = sky.map((b) => {
    const name = t(b.kind === 'sun' ? 'sky.sun' : 'sky.moon');
    const kind = b.kind as 'sun' | 'moon';
    return { key: kind, name, names: [name, kind], az: b.az, alt: b.alt, kind, rank: 30 };
  });
  // Satelliten: alle (auch unter dem Horizont), Lage aus der laufenden Rechnung
  const up = new Map(satNow.map((s) => [s.key, s]));
  for (const s of satList) {
    const now = up.get(s.key);
    out.push({ key: s.key, name: s.name, names: [s.name], az: now?.az ?? 0, alt: now?.alt ?? -90, kind: 'sat', rank: s.major ? 20 : 5 });
  }
  if (night) {
    for (const o of night.objects) {
      out.push({ key: o.key, name: o.name, names: [o.name, o.key.slice(o.key.indexOf(':') + 1)], az: o.az, alt: o.alt, kind: o.kind, rank: 10 - o.mag });
    }
    preparedSky?.data.constellations.forEach((c, i) => {
      const l = night!.labels[i];
      if (l) out.push({ key: `con:${c.id}`, name: l.text, names: Object.values(c.names), az: l.az, alt: l.alt, kind: 'constellation', rank: 0 });
    });
  }
  return out;
}

/** Ziel der Suche als Name und Richtung (Gipfel oder Himmelskörper). */
function targetPoint(): { name: string; az: number; angle: number } | null {
  if (targetId !== null) {
    const p = pano?.peaks.find((q) => q.id === targetId);
    return p ? { name: peakName(p), az: p.az, angle: p.angle } : null;
  }
  if (targetSky !== null) {
    const o = skyItems().find((x) => x.key === targetSky);
    if (o?.kind === 'sat' && o.alt <= 0) {
      // Noch unter dem Horizont: dorthin, wo er beim nächsten Überflug aufgeht
      const rise = satPass(o.key)?.path[0];
      return rise ? { name: o.name, az: rise.az, angle: rise.alt } : null;
    }
    return o ? { name: o.name, az: o.az, angle: o.alt } : null;
  }
  return null;
}

function aboveTerrainNow(az: number, alt: number): boolean {
  const p = pano;
  return !p || alt >= p.horizon[Math.round(az / p.azStep) % p.horizon.length];
}

function showResults() {
  const q = fold(searchInput.value.trim());
  type Hit = { score: number; rank: number; label: string; meta: () => string; pick: () => void };
  const hits: Hit[] = [];
  const dirOf = (az: number) => `${compassLabels(16)[Math.round(az / 22.5) % 16]} ${Math.round(az)}°`;
  if (q && showTerrainIn.checked) {
    // Reihenfolge der Gipfel untereinander wie scorePeaks (Bekanntheit, sichtbar, Höhe)
    scorePeaks(pano?.peaks ?? [], q).forEach(({ p, s: score }, i, all) => {
      hits.push({
        score,
        rank: all.length - i,
        label: peakName(p),
        meta: () =>
          `${Math.round(p.ele)} m · ${(p.dist / 1000).toFixed(p.dist < 10_000 ? 1 : 0)} km · ${dirOf(p.az)}` + (p.visible ? '' : ` · ${t('peak.hidden')}`),
        pick: () => setTarget({ peak: p }),
      });
    });
  }
  if (q && showSkyIn.checked) {
    for (const o of skyItems()) {
      const score = nameScore(o.names, q);
      if (!score) continue;
      const kind = o.kind === 'planet' ? t('search.planet') : o.kind === 'star' ? t('search.star') : o.kind === 'constellation' ? t('search.constellation') : o.kind === 'sat' ? t('search.sat') : '';
      // Satelliten unter dem Horizont: nächster Überflug; erst für gezeigte Treffer rechnen
      const meta = () => {
        const up = aboveTerrainNow(o.az, o.alt);
        const where = o.kind === 'sat' && !up ? skyDetails(o.key) : up ? `${o.alt.toFixed(0)}° · ${dirOf(o.az)}` : t('search.below');
        return [kind, where].filter(Boolean).join(' · ');
      };
      hits.push({ score, rank: o.rank, label: o.name, meta, pick: () => setTarget({ sky: o.key }) });
    }
  }
  hits.sort((a, b) => b.score - a.score || b.rank - a.rank);
  searchResults.replaceChildren(
    ...hits.slice(0, 10).map((h) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      const name = document.createElement('span');
      name.textContent = h.label;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = h.meta();
      btn.append(name, meta);
      btn.addEventListener('click', h.pick);
      li.append(btn);
      return li;
    }),
  );
  if (q.trim() && !hits.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = t('search.none');
    searchResults.append(li);
  }
}

/** Ziel setzen; ohne Sensor dreht sich der Blick direkt hin. */
function setTarget(target: { peak: Peak } | { sky: string } | null) {
  targetId = target && 'peak' in target ? target.peak.id : null;
  targetSky = target && 'sky' in target ? target.sky : null;
  setSearch(false);
  const p = targetPoint();
  if (p && !sensorOn) {
    cam.heading = p.az;
    cam.pitch = Math.max(-30, Math.min(30, p.angle));
    writeHash();
  }
  requestRender();
}
$<HTMLButtonElement>('target-close').addEventListener('click', () => setTarget(null));

/** Ziel-Chip: Name und Drehrichtung in Worten. */
function syncTarget() {
  const p = targetPoint();
  targetChip.hidden = !p;
  if (!p) return;
  // Himmelskörper unter dem Gelände: Richtung zeigen, aber dazusagen
  const name = targetSky !== null && !aboveTerrainNow(p.az, p.angle) ? `${p.name} (${t('search.below')})` : p.name;
  const turn = turnToTarget(cam, p.az);
  const vfov = (cam.hfov * cam.height) / cam.width;
  const dp = p.angle - cam.pitch;
  targetText.textContent =
    turn > 0
      ? t('target.right', { name, deg: Math.round(turn) })
      : turn < 0
        ? t('target.left', { name, deg: Math.round(-turn) })
        : dp > vfov / 2
          ? t('target.up', { name })
          : dp < -vfov / 2
            ? t('target.down', { name })
            : t('target.inView', { name });
}

// --- Sensormodus -------------------------------------------------------------------

function fmtSigned(v: number, digits = 1): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
}

/** Kompasskurs → geografischer Kurs (ohne Nordbezug keine Missweisung). */
function trueHeading(heading: number): number {
  return tracker.status === 'absolute' ? heading + declination : heading;
}

const declinationEl = $<HTMLParagraphElement>('declination');
function updateDeclination(lat: number, lon: number) {
  declination = magneticDeclination(lat, lon, decimalYear(new Date()));
  if (legacyOffset) {
    offset.heading = deltaDeg(offset.heading - declination, 0);
    legacyOffset = false;
    saveOffset('legacy');
  }
  declinationEl.hidden = false;
  showDeclination();
}
function showDeclination() {
  declinationEl.textContent = t('settings.declination', { d: fmtSigned(declination) });
}

/** Übernimmt Sensorwerte + Korrektur in die Kamera. */
/**
 * Verzögerung des Kamerabilds (Aufnahme → Anzeige, ms), gemessen per
 * requestVideoFrameCallback; ohne captureTime typischer Wert für Android.
 */
let videoLatency = 100;
type FrameMeta = { captureTime?: number; expectedDisplayTime: number };
type RvfcVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number };
function watchVideoFrames() {
  const v = videoEl as RvfcVideo;
  if (!v.requestVideoFrameCallback) return;
  const onFrame = (_now: number, meta: FrameMeta) => {
    if (meta.captureTime !== undefined && meta.captureTime > 0) {
      const l = meta.expectedDisplayTime - meta.captureTime;
      if (l > 0 && l < 500) videoLatency += 0.1 * (l - videoLatency);
    }
    // Jedes neue Kamerabild mit passender Lage zeichnen
    if (cameraShown()) requestRender();
    v.requestVideoFrameCallback!(onFrame);
  };
  v.requestVideoFrameCallback(onFrame);
}

function syncSensor() {
  // Über dem Kamerabild die Lage zum Aufnahmezeitpunkt, sonst laufen die Linien voraus
  const a = !sensorOn ? null : cameraShown() ? tracker.anglesAt(performance.now() - videoLatency) : tracker.angles;
  if (!a) {
    cam.roll = 0;
    return;
  }
  cam.heading = normalizeDeg(trueHeading(a.heading) + totalHeadingOffset());
  cam.pitch = a.pitch + totalPitchOffset();
  cam.roll = a.roll;
  const dir = compassLabels(16)[Math.round(cam.heading / 22.5) % 16];
  // Nur die eigene (manuelle) Kurskorrektur anzeigen, und nur wenn vorhanden
  const corrected = manualCal && Math.abs(manualAdj.heading) >= 0.05;
  sensorText.textContent =
    `${dir} ${cam.heading.toFixed(0)}°` +
    (corrected ? ` · ${t('sensor.corrected', { offset: fmtSigned(manualAdj.heading) })}` : '') +
    (tracker.status === 'relative' ? ` · ${t('sensor.noCompass')}` : '') +
    (performance.now() - lastMatchAt < 3000
      ? ` · ${t(({ skyline: 'sensor.matched', pitch: 'sensor.matchedPitch', pano: 'sensor.matchedPano', stars: 'sensor.matchedStars', fov: 'sensor.matchedFov', sun: 'sensor.matchedSun', moon: 'sensor.matchedMoon' } as const)[lastMatchSource])}`
      : '');
}

/** Rauschanzeige im offenen Einstellungsblatt: zeigt, welche Achse zittert. */
const noiseEl = $<HTMLParagraphElement>('sensor-noise');
function updateNoise() {
  const camRow = manualCal && cameraShown() && panel.hidden === false;
  cameraFovRow.hidden = !camRow;
  if (camRow) cameraFovText.textContent = t('settings.cameraFov', { fov: (cameraFov * manualAdj.fov).toFixed(1) });
  const n = sensorOn && panel.hidden === false ? tracker.noise : null;
  noiseEl.hidden = !n;
  if (n) noiseEl.textContent = t('settings.noise', { h: n.heading.toFixed(1), p: n.pitch.toFixed(1), r: n.roll.toFixed(1) });
  if (panel.hidden === false) showCorrLog();
}

const corrLogEl = $<HTMLParagraphElement>('corr-log');
const SOURCE_KEYS = {
  skyline: 'sensor.matched',
  pitch: 'sensor.matchedPitch',
  pano: 'sensor.matchedPano',
  stars: 'sensor.matchedStars',
  fov: 'sensor.matchedFov',
  sun: 'sensor.matchedSun',
  moon: 'sensor.matchedMoon',
  drag: 'log.drag',
  apply: 'log.apply',
  legacy: 'log.legacy',
  reset: 'log.reset',
} as const;
function showCorrLog() {
  const head = t('log.title', { h: fmtSigned(totalHeadingOffset()), p: fmtSigned(totalPitchOffset()) });
  const time = (ms: number) => new Date(ms).toLocaleTimeString(lang(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const lines = corrLog
    .slice()
    .reverse()
    .map((e) => `${time(e.t)} ${t(SOURCE_KEYS[e.src])}: ${t('log.delta', { dh: fmtSigned(e.dh), dp: fmtSigned(e.dp) })}`);
  corrLogEl.textContent = [head, ...lines].join('\n');
}

/** Sensormodus ist an, sobald Orientierungsdaten kommen; vorher und ohne Sensor: manuell. */
function applySensorUi() {
  sensorInfo.hidden = !sensorOn;
  document.body.classList.toggle('sensor-on', sensorOn);
  updateAlignBar();
  requestRender();
}

/** Startet die Sensoren ohne Rückfrage; iOS holt die Erlaubnis bei der ersten Berührung nach. */
function startSensors() {
  tracker.start();
  window.setTimeout(() => {
    if (tracker.angles) return;
    if (OrientationTracker.needsPermission) {
      document.addEventListener('pointerup', () => void tracker.requestPermission(), { once: true });
    }
    if ('brave' in navigator) setNotice('sensor', () => t('sensor.brave'));
  }, 3000);
}

$<HTMLButtonElement>('offset-reset').addEventListener('click', () => {
  offset.heading = 0;
  offset.pitch = 0;
  Object.assign(manualAdj, { heading: 0, pitch: 0, fov: 1 });
  saveOffset('reset');
  requestRender();
});

window.addEventListener('hashchange', () => {
  if (readHash()) {
    presetSel.value = '';
    compute();
    requestRender();
  }
});

// --- Bildschirm an lassen (Screen Wake Lock) --------------------------------------

let wakeLock: WakeLockSentinel | null = null;
async function keepScreenOn() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || (wakeLock && !wakeLock.released)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // z. B. Energiesparmodus; ohne Wake Lock weiter
  }
}
// Sperre endet beim Wechsel in den Hintergrund; danach neu anfordern
document.addEventListener('visibilitychange', () => void keepScreenOn());
// Manche Browser verlangen eine Nutzergeste
document.addEventListener('pointerdown', () => void keepScreenOn());
void keepScreenOn();

// --- Installierbare App (PWA) ------------------------------------------------------

// --- Offline -----------------------------------------------------------------------

// Gespeicherte Kacheln nicht vom Browser wegräumen lassen (Offline am Berg)
void navigator.storage?.persist?.().catch(() => false);

const offlineBtn = $<HTMLButtonElement>('offline-save');
const offlineStatus = $<HTMLParagraphElement>('offline-status');
offlineBtn.addEventListener('click', async () => {
  const lat = pano?.request.lat ?? Number(latIn.value);
  const lon = pano?.request.lon ?? Number(lonIn.value);
  const radius = (pano?.request.radius ?? Number(radiusIn.value) * 1000) || 100_000;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  offlineBtn.disabled = true;
  offlineStatus.hidden = false;
  const mb = (b: number) => (b / 1e6).toFixed(0);
  const p = await prefetchArea({ lat, lon }, radius, (p) => {
    offlineStatus.textContent = t('offline.progress', { done: p.done, total: p.total, mb: mb(p.bytes) });
  });
  offlineStatus.textContent = p.failed ? t('offline.failed', { n: p.failed }) : t('offline.done', { n: p.total, mb: mb(p.bytes) });
  offlineBtn.disabled = false;
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service Worker:', err));
}

// --- Neue Version ------------------------------------------------------------------
// Nach einem Deploy fehlen die Dateien der alten Version auf dem Server; eine lange offene
// App würde mit halb altem Code weiterlaufen. Beim Zurückkehren in die App still neu laden,
// während der Nutzung nur einen Hinweis zeigen.

const updateToast = $<HTMLDivElement>('update');
let lastVersionCheck = 0;

async function newVersionAvailable(): Promise<boolean> {
  if (!import.meta.env.PROD || !navigator.onLine) return false;
  lastVersionCheck = Date.now();
  try {
    const res = await fetch('./version.json', { cache: 'no-store' });
    if (!res.ok) return false;
    const { build } = (await res.json()) as { build?: string };
    return !!build && build !== import.meta.env.VITE_BUILD_ID;
  } catch {
    return false;
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || Date.now() - lastVersionCheck < 60_000) return;
  if (await newVersionAvailable()) location.reload();
});
window.setInterval(async () => {
  if (document.visibilityState === 'visible' && updateToast.hidden && (await newVersionAvailable())) updateToast.hidden = false;
}, 15 * 60_000);
$<HTMLButtonElement>('update-reload').addEventListener('click', () => location.reload());

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}
const installBtn = $<HTMLButtonElement>('install');
let installPrompt: InstallPromptEvent | null = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e as InstallPromptEvent;
  installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  await installPrompt?.prompt();
  installPrompt = null;
  installBtn.hidden = true;
});
window.addEventListener('appinstalled', () => (installBtn.hidden = true));

// --- Kamerabild ------------------------------------------------------------------

const videoEl = $<HTMLVideoElement>('camera');
watchVideoFrames();
const cameraFeed = new CameraFeed(videoEl);
const cameraBtn = $<HTMLButtonElement>('camera-toggle');
const CAMERA_PREF_KEY = 'ridge-lens-camera';
// v2: ab hier wird die Hauptkamera gewählt; ältere Kalibrierungen stammen oft von der Ultraweitwinkel-Kamera
const CAMERA_FOV_KEY = 'ridge-lens-camera-fov-v2';
const CAMERA_DEVICE_KEY = 'ridge-lens-camera-device';
let cameraWanted = false;
let cameraFov = loadNumber(CAMERA_FOV_KEY) ?? DEFAULT_CAMERA_FOV;
/** Gewählte Kamera ('' = automatisch Hauptkamera). */
let cameraDevice = loadString(CAMERA_DEVICE_KEY);
/** Sichtfeld vor dem Einschalten der Kamera, wird beim Ausschalten wiederhergestellt. */
let manualHfov = cam.hfov;

function loadNumber(key: string): number | null {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function loadString(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function saveCameraFov() {
  try {
    localStorage.setItem(CAMERA_FOV_KEY, String(cameraFov));
  } catch {
    /* kein Speicher */
  }
}

function cameraShown(): boolean {
  return cameraWanted && cameraFeed.active && cameraFeed.size.w > 0;
}

/** Mit Kamerabild ergibt sich das Sichtfeld aus Kamera-Bildwinkel und Bildausschnitt. */
function syncCameraFov() {
  if (!cameraShown()) return;
  const { w, h } = cameraFeed.size;
  cam.hfov = displayHfov(Math.min(120, cameraFov * manualAdj.fov), w, h, cam.width, cam.height);
}

async function setCamera(on: boolean, remember = true) {
  if (remember) {
    try {
      localStorage.setItem(CAMERA_PREF_KEY, on ? 'on' : 'off');
    } catch {
      /* kein Speicher */
    }
  }
  if (on) {
    if (!cameraWanted) manualHfov = cam.hfov;
    cameraWanted = true;
    try {
      await cameraFeed.start(cameraDevice || undefined);
      setNotice('camera', null);
      void fillCameraSelect();
    } catch (err) {
      cameraWanted = false;
      const msg = err instanceof Error ? err.name || err.message : String(err);
      setNotice('camera', () => t('camera.unavailable', { msg }));
    }
  } else {
    cameraWanted = false;
    cameraFeed.stop();
    cam.hfov = manualHfov;
  }
  cameraBtn.setAttribute('aria-pressed', String(cameraWanted));
  document.body.classList.toggle('camera-on', cameraWanted);
  requestRender();
}

cameraBtn.addEventListener('click', () => void setCamera(!cameraWanted));
videoEl.addEventListener('loadedmetadata', requestRender);
videoEl.addEventListener('resize', requestRender);
/**
 * Im Hintergrund Kamera freigeben, im Vordergrund neu öffnen: Android lässt den Strom
 * sonst oft formal "live", liefert aber keine Bilder mehr (Standbild).
 */
let cameraRestart: Promise<void> | null = null;
function restartCamera() {
  if (cameraRestart || !cameraWanted || document.hidden) return;
  cameraFeed.stop();
  cameraRestart = setCamera(true, false).finally(() => (cameraRestart = null));
}
document.addEventListener('visibilitychange', () => {
  if (!cameraWanted) return;
  if (document.hidden) cameraFeed.stop();
  else restartCamera();
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) restartCamera();
});
// Wächter: steht das Videobild trotz sichtbarer Seite, Kamera neu starten
let lastVideoTime = -1;
let stalledTicks = 0;
setInterval(() => {
  if (!cameraWanted || document.hidden || cameraRestart) {
    stalledTicks = 0;
    return;
  }
  const t = videoEl.currentTime;
  stalledTicks = t === lastVideoTime || !cameraFeed.active ? stalledTicks + 1 : 0;
  lastVideoTime = t;
  if (videoEl.paused) void videoEl.play().catch(() => {});
  if (stalledTicks >= 2) {
    stalledTicks = 0;
    restartCamera();
  }
}, 1500);

/** Kamera-Auswahl in den Einstellungen (nur bei mehreren Rückkameras). */
const cameraSelect = $<HTMLSelectElement>('camera-select');
async function fillCameraSelect() {
  const cams = await cameraFeed.backCameras();
  cameraSelect.parentElement!.hidden = cams.length < 2;
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = t('settings.cameraAuto');
  cameraSelect.replaceChildren(
    auto,
    ...cams.map((c, i) => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.label || `${t('aria.camera')} ${i + 1}`;
      return o;
    }),
  );
  cameraSelect.value = cams.some((c) => c.id === cameraDevice) ? cameraDevice : '';
}
cameraSelect.addEventListener('change', async () => {
  cameraDevice = cameraSelect.value;
  try {
    localStorage.setItem(CAMERA_DEVICE_KEY, cameraDevice);
  } catch {
    /* kein Speicher */
  }
  // Andere Kamera, anderer Bildwinkel: Kalibrierung neu beginnen
  cameraFov = DEFAULT_CAMERA_FOV;
  saveCameraFov();
  manualAdj.fov = 1;
  saveManualAdj();
  if (cameraWanted) {
    cameraFeed.stop();
    await setCamera(true, false);
  }
});

const cameraFovRow = $<HTMLDivElement>('camera-fov-row');
const cameraFovText = $<HTMLSpanElement>('camera-fov');
$<HTMLButtonElement>('camera-fov-reset').addEventListener('click', () => {
  cameraFov = DEFAULT_CAMERA_FOV;
  saveCameraFov();
  manualAdj.fov = 1;
  saveManualAdj();
  requestRender();
});

// --- Automatischer Abgleich am Kamerabild -----------------------------------------

/** Manuelle Kalibrierung (Ziehen, Zoomen, Gipfel übernehmen); sonst nur Bildabgleich. */
const manualCalIn = $<HTMLInputElement>('manual-cal');
const manualTools = $<HTMLDivElement>('manual-tools');
const MANUAL_CAL_KEY = 'ridge-lens-manual-cal';
try {
  manualCal = localStorage.getItem(MANUAL_CAL_KEY) === 'on';
} catch {
  /* kein Speicher */
}
manualCalIn.checked = manualCal;
manualTools.hidden = !manualCal;
manualCalIn.addEventListener('change', () => {
  manualCal = manualCalIn.checked;
  manualTools.hidden = !manualCal;
  // Ausschalten verwirft alles von Hand Eingestellte; die Bildkorrektur bleibt
  if (!manualCal) {
    Object.assign(manualAdj, { heading: 0, pitch: 0, fov: 1 });
    saveOffset('reset');
    requestRender();
  }
  try {
    localStorage.setItem(MANUAL_CAL_KEY, manualCal ? 'on' : 'off');
  } catch {
    /* kein Speicher */
  }
  updateAlignBar();
  updateNoise();
  requestRender();
});

const visionWorker = new Worker(new URL('./vision-worker.ts', import.meta.url), { type: 'module' });
const autoAlignIn = $<HTMLInputElement>('auto-align');
const AUTO_ALIGN_KEY = 'ridge-lens-auto-align';
try {
  autoAlignIn.checked = localStorage.getItem(AUTO_ALIGN_KEY) !== 'off';
} catch {
  /* kein Speicher */
}
autoAlignIn.addEventListener('change', () => {
  try {
    localStorage.setItem(AUTO_ALIGN_KEY, autoAlignIn.checked ? 'on' : 'off');
  } catch {
    /* kein Speicher */
  }
});

const VISION_COLS = 160;
/** Anteil einer Korrektur, der pro Abgleich übernommen wird (gleitend statt sprunghaft). */
const VISION_GAIN = 0.5;
const visionCanvas = document.createElement('canvas');
const visionCtx = visionCanvas.getContext('2d', { willReadFrequently: true })!;
let visionHorizon: Float32Array | null = null;
let visionBusy = false;
let visionId = 0;
let lastMatchAt = -Infinity;
let lastMatchSource: VisionResponse['source'] | 'fov' = 'skyline';
let lastPose: { heading: number; pitch: number } | null = null;

/** Ein Videobild im angezeigten Ausschnitt (object-fit: cover) verkleinert an den Worker. */
/** Ruhiger Abgleich: Zahl kleiner Korrekturen in Folge, Blick dabei, letzter Versand. */
let calmCount = 0;
let calmPose = { heading: 0, pitch: 0 };
let lastVisionSent = 0;

function visionTick() {
  const pose = { heading: cam.heading, pitch: cam.pitch };
  const dh = lastPose ? Math.abs(deltaDeg(pose.heading, lastPose.heading)) : Infinity;
  const dp = lastPose ? Math.abs(pose.pitch - lastPose.pitch) : Infinity;
  const steady = dh < 1.5 && dp < 1;
  // Langsames Schwenken: Bild nur fürs Rundumprofil (Bildverzögerung verschmiert sonst den Kurs)
  const moving = !steady && dh < 6 && dp < 2;
  lastPose = pose;
  // Akku: ist die Ausrichtung stabil und der Blick ruhig, nur noch alle 4 s abgleichen
  const now = performance.now();
  if (Math.abs(deltaDeg(pose.heading, calmPose.heading)) > 8 || Math.abs(pose.pitch - calmPose.pitch) > 5) {
    calmCount = 0;
    calmPose = pose;
  }
  if (calmCount >= 3 && now - lastVisionSent < 4000) return;
  if (!autoAlignIn.checked || visionBusy || !(steady || moving) || !pano || !pano.complete || !sensorOn || !cameraShown() || document.hidden) return;
  if (visionHorizon !== pano.horizon) {
    visionHorizon = pano.horizon;
    visionWorker.postMessage({
      type: 'horizon',
      horizon: pano.horizon.slice(),
      haze: pano.hazeHorizons.map((b) => b.horizon.slice()),
      azStep: pano.azStep,
    } satisfies VisionRequest);
  }
  const { w: vw, h: vh } = cameraFeed.size;
  const scale = Math.max(cam.width / vw, cam.height / vh);
  const sw = cam.width / scale;
  const sh = cam.height / scale;
  const cols = VISION_COLS;
  const rows = Math.round((cols * cam.height) / cam.width);
  visionCanvas.width = cols;
  visionCanvas.height = rows;
  visionCtx.drawImage(videoEl, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, cols, rows);
  const pixels = visionCtx.getImageData(0, 0, cols, rows).data;
  const stars = !moving ? starFrame(vw, vh, sw, sh) : undefined;
  visionBusy = true;
  lastVisionSent = now;
  offsetPitchAtSend = totalPitchOffset();
  offsetHeadingAtSend = totalHeadingOffset();
  visionWorker.postMessage(
    {
      type: 'frame',
      id: ++visionId,
      pixels,
      cols,
      rows,
      cam: { ...cam },
      bodies: visionBodies(),
      offHeading: totalHeadingOffset(),
      offPitch: totalPitchOffset(),
      moving,
      stars,
    } satisfies VisionRequest,
    stars ? [pixels.buffer, stars.pixels.buffer] : [pixels.buffer],
  );
}

/** Nachts: Ausschnitt in 480 px Breite (Sterne verschwinden beim starken Verkleinern) und Sterne im Blickfeld. */
const starCanvas = document.createElement('canvas');
const starCtx = starCanvas.getContext('2d', { willReadFrequently: true })!;
function starFrame(vw: number, vh: number, sw: number, sh: number) {
  if (!night || night.fade < 0.6) return undefined;
  const refs: StarRef[] = [];
  const inView = (az: number, alt: number) => alt > 3 && azimuthInView(cam, az, 12);
  for (let i = 0; i < night.mag.length; i++) {
    const az = night.pos[2 * i];
    const alt = night.pos[2 * i + 1];
    if (night.mag[i] < 2.5 && inView(az, alt)) refs.push({ az, alt, mag: night.mag[i] });
  }
  for (const o of night.objects) if (o.kind === 'planet' && o.mag < 2 && inView(o.az, o.alt)) refs.push({ az: o.az, alt: o.alt, mag: o.mag });
  if (refs.length < 3) return undefined;
  const cols = 480;
  const rows = Math.round((cols * cam.height) / cam.width);
  starCanvas.width = cols;
  starCanvas.height = rows;
  starCtx.drawImage(videoEl, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, cols, rows);
  return { pixels: starCtx.getImageData(0, 0, cols, rows).data, cols, rows, refs };
}

/** Sonne (über dem Gelände) bzw. nachts der Mond als Fixpunkte für den Bildabgleich. */
function visionBodies(): BodyTarget[] {
  const p = pano;
  const visible = (b: SkyBody) => !!p && b.alt >= p.horizon[Math.round(b.az / p.azStep) % p.horizon.length] + 0.5;
  const sun = sky.find((b) => b.kind === 'sun');
  const moon = sky.find((b) => b.kind === 'moon');
  const out: BodyTarget[] = [];
  if (sun && visible(sun)) out.push({ kind: 'sun', az: sun.az, alt: sun.alt });
  // Mond nur in der Dämmerung/Nacht: tagsüber zu kontrastarm
  if (moon && visible(moon) && (!sun || sun.alt < -4)) out.push({ kind: 'moon', az: moon.az, alt: moon.alt });
  return out;
}

/**
 * Bildwinkel-Kalibrierung beim Neigen: Messpunkte des Neigungsabgleichs (Lage des
 * Horizonts im Bild, nötige Gesamt-Neigungskorrektur) für den aktuellen Bildwinkel.
 */
let tiltSamples: (TiltSample & { t: number; fov: number })[] = [];
/** Neigungskorrektur beim Absenden des Bilds (die Antwort kommt eine Weile später). */
let offsetPitchAtSend = 0;
let offsetHeadingAtSend = 0;
/** Unbestätigter großer Kurssprung: Ziel-Korrektur und Zeitpunkt. */
let headingCandidate: { offset: number; t: number } | null = null;
/** Große Kurskorrektur erst, wenn ein zweites Bild sie bestätigt (Fehltreffer kommen vereinzelt). */
function confirmHeading(dHeading: number): boolean {
  if (Math.abs(dHeading) < 1.5) return true;
  const now = performance.now();
  const target = offsetHeadingAtSend + dHeading;
  const ok = !!headingCandidate && now - headingCandidate.t < 15_000 && Math.abs(deltaDeg(target, headingCandidate.offset)) < 1;
  headingCandidate = { offset: target, t: now };
  return ok;
}

function calibrateFromTilt(match: MatchResult, snap: Camera): boolean {
  const now = performance.now();
  tiltSamples = tiltSamples.filter((s) => now - s.t < 180_000 && s.fov === cameraFov).slice(-40);
  tiltSamples.push({ axis: match.axis ?? 0, pitch: offsetPitchAtSend + match.dPitch, t: now, fov: cameraFov });
  const fit = fitTilt(tiltSamples);
  if (!fit) return false;
  const { w, h } = cameraFeed.size;
  const hfov = (2 * Math.atan(Math.tan((snap.hfov / 2) * (Math.PI / 180)) * fit.scale) * 180) / Math.PI;
  cameraFov = Math.min(120, Math.max(30, fovLongFromDisplay(hfov, w, h, snap.width, snap.height) / manualAdj.fov));
  saveCameraFov();
  offset.pitch = Math.max(-20, Math.min(20, fit.pitch - manualAdj.pitch));
  saveOffset('fov');
  tiltSamples = [];
  return true;
}

visionWorker.onmessage = (ev: MessageEvent<VisionResponse>) => {
  visionBusy = false;
  const { match, cam: snap } = ev.data;
  const source = ev.data.source;
  if (!match.ok || !sensorOn || !cameraShown()) return;
  calmCount = Math.abs(match.dHeading) < 0.3 && Math.abs(match.dPitch) < 0.2 ? calmCount + 1 : 0;
  if (source === 'pitch' && calibrateFromTilt(match, snap)) {
    lastMatchAt = performance.now();
    lastMatchSource = 'fov';
    requestRender();
    return;
  }
  if (source !== 'pitch' && !confirmHeading(match.dHeading)) return;
  // Bildbezug hält den Kurs; der Kompass zieht ihn danach nur noch langsam nach
  if (source !== 'pitch') tracker.holdCompass(120_000);
  // Korrekturen beziehen sich auf die Kamera zum Aufnahmezeitpunkt; Offsets sind darin enthalten
  offset.heading = deltaDeg(offset.heading + VISION_GAIN * match.dHeading, 0);
  offset.pitch = Math.max(-20, Math.min(20, offset.pitch + VISION_GAIN * match.dPitch));
  saveOffset(source);
  if (source === 'skyline') {
    const { w, h } = cameraFeed.size;
    const hfov = snap.hfov * (1 + VISION_GAIN * (match.fovScale - 1));
    cameraFov = Math.min(120, Math.max(30, fovLongFromDisplay(hfov, w, h, snap.width, snap.height) / manualAdj.fov));
    saveCameraFov();
  }
  lastMatchAt = performance.now();
  lastMatchSource = source;
  requestRender();
};
visionWorker.onerror = () => (visionBusy = false);
setInterval(visionTick, 1000);

// --- Sprache ----------------------------------------------------------------------

const langSel = $<HTMLSelectElement>('lang');
function applyLang(choice: Lang | 'auto') {
  setLang(choice === 'auto' ? detectLang() : choice);
  langSel.value = choice;
  applyDom();
  setStatus(baseStatus);
  showDeclination();
  showSkyInfo();
  updateAlignBar();
  requestRender();
}
langSel.addEventListener('change', () => {
  const choice = langSel.value as Lang | 'auto';
  storeLangChoice(choice);
  applyLang(choice);
});
// Systemsprache kann sich ändern, solange "automatisch" gewählt ist
window.addEventListener('languagechange', () => {
  if (storedLangChoice() === 'auto') applyLang('auto');
});

// --- Start ------------------------------------------------------------------------

applyLang(storedLangChoice());
if (showSkyIn.checked) void loadSats();
setStatus(() => t('status.ready'));

// Ort aus URL bzw. Vorgabe als Rückfall; standardmäßig GPS und Sensoren
const fromHash = readHash();
if (!fromHash) {
  applyPreset(PRESETS[0]);
  presetSel.value = '0';
}
resize();
// Sensoren und Kamera nur auf Touch-Geräten; Desktop hat keine Lagesensoren
if (matchMedia('(pointer: coarse)').matches) {
  startSensors();
  // Kamerabild standardmäßig an, außer der Nutzer hat es ausgeschaltet
  let pref: string | null = null;
  try {
    pref = localStorage.getItem(CAMERA_PREF_KEY);
  } catch {
    /* kein Speicher */
  }
  if (pref !== 'off') void setCamera(true, false);
}
void locate().then((err) => {
  if (err) setNotice('gps', () => t('gps.fallback', { err: err(), place: fromHash ? t('gps.placeFromLink') : PRESETS[0].name }));
  compute();
});
