import { deltaDeg, normalizeDeg } from './geo';
import { OrientationTracker } from './orientation';
import type { Camera } from './projection';
import type { ComputeRequest, PanoramaResult, Peak, WorkerMessage } from './protocol';
import { applyDom, compassLabels, detectLang, lang, setLang, storedLangChoice, storeLangChoice, t, type Lang } from './i18n';
import { DARK, LIGHT, renderOverview, renderView, type PlacedLabel } from './render';

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
const OFFSET_KEY = 'ridge-lens-offset';
const offset = loadOffset();

function loadOffset(): { heading: number; pitch: number } {
  try {
    const o = JSON.parse(localStorage.getItem(OFFSET_KEY) ?? '');
    if (Number.isFinite(o.heading) && Number.isFinite(o.pitch)) return o;
  } catch {
    /* kein gespeicherter Offset */
  }
  return { heading: 0, pitch: 0 };
}

function saveOffset() {
  try {
    localStorage.setItem(OFFSET_KEY, JSON.stringify(offset));
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
  updateNoise();
  const dpr = devicePixelRatio || 1;
  const palette = darkScheme.matches ? DARK : LIGHT;
  viewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  labels = renderView(viewCtx, cam, pano, {
    palette,
    showHidden: hiddenIn.checked,
    crosshair: sensorOn,
    selectedPeakId: selected?.id ?? null,
    peakName,
    compass: compassLabels(8),
    // Skala und Labels unterhalb der Statuszeile beginnen
    topInset: statusEl.getBoundingClientRect().bottom - view.getBoundingClientRect().top,
  });
  if (overview.clientWidth) {
    overCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderOverview(overCtx, overview.clientWidth, overview.clientHeight, cam, pano, palette, compassLabels(8));
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
worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
  const msg = ev.data;
  if (msg.type === 'progress') {
    setStatus(() => t(msg.key, msg.params));
    return;
  }
  busy = false;
  if (msg.type === 'error') {
    setStatus(() => (msg.detail ? t('status.error', { msg: msg.detail }) : t(msg.key)));
    return;
  }
  const result = msg.result;
  pano = result;
  selected = null;
  updateAlignBar();
  const visible = result.peaks.filter((p) => p.visible).length;
  setStatus(() =>
    [
      t('status.result', { ele: Math.round(result.h0), count: visible }),
      result.failedTiles ? t('status.tilesMissing', { n: result.failedTiles }) : '',
      result.peakError ? t('error.peaks', { detail: result.peakError }) : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );
  requestRender();
};

function compute() {
  if (busy) return;
  const lat = Number(latIn.value);
  const lon = Number(lonIn.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85) {
    setStatus(() => t('status.invalidCoords'));
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
  setStatus(() => t('status.start'));
  writeHash();
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
  if (e.key === 'Escape') setPanel(false);
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

/** Blick drehen/neigen; im Sensormodus wird stattdessen die Korrektur verschoben. */
function rotateBy(dHeading: number, dPitch: number) {
  if (sensorOn) {
    offset.heading = deltaDeg(offset.heading + dHeading, 0);
    offset.pitch = Math.max(-20, Math.min(20, offset.pitch + dPitch));
    saveOffset();
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
    if (pinchDist) cam.hfov = clampFov((cam.hfov * pinchDist) / d);
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
    cam.hfov = clampFov(cam.hfov * Math.exp(e.deltaY * 0.001));
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
  else if (e.key === '+') cam.hfov = clampFov(cam.hfov / 1.2);
  else if (e.key === '-') cam.hfov = clampFov(cam.hfov * 1.2);
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

/** Antippen eines Labels wählt den Gipfel (für Anpeilen/Zentrieren). */
function selectAt(e: PointerEvent) {
  const hit = labelAt(e, 14);
  selected = hit && hit.peak.id !== selected?.id ? hit.peak : null;
  updateAlignBar();
  requestRender();
}

function updateAlignBar() {
  alignBar.hidden = !selected;
  if (!selected) return;
  alignText.textContent = sensorOn
    ? t('align.instruction', { name: peakName(selected) })
    : `${peakName(selected)} · ${peakDetails(selected)}`;
  alignApply.textContent = t(sensorOn ? 'align.apply' : 'align.center');
}

alignApply.addEventListener('click', () => {
  if (!selected) return;
  const a = tracker.angles;
  if (sensorOn && a) {
    // Korrektur so, dass der Gipfel genau im Fadenkreuz liegt
    offset.heading = deltaDeg(selected.az, a.heading);
    offset.pitch = Math.max(-20, Math.min(20, selected.angle - a.pitch));
    saveOffset();
    const peak = selected;
    const correction = fmtSigned(offset.heading);
    setStatus(() => t('align.done', { name: peakName(peak), offset: correction }));
  } else if (!sensorOn) {
    cam.heading = selected.az;
    cam.pitch = Math.max(-30, Math.min(30, selected.angle));
    writeHash();
  }
  selected = null;
  updateAlignBar();
  requestRender();
});
$<HTMLButtonElement>('align-close').addEventListener('click', () => {
  selected = null;
  updateAlignBar();
  requestRender();
});

// --- Sensormodus -------------------------------------------------------------------

function fmtSigned(v: number, digits = 1): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
}

/** Übernimmt Sensorwerte + Korrektur in die Kamera. */
function syncSensor() {
  const a = sensorOn ? tracker.angles : null;
  if (!a) {
    cam.roll = 0;
    return;
  }
  cam.heading = normalizeDeg(a.heading + offset.heading);
  cam.pitch = a.pitch + offset.pitch;
  cam.roll = a.roll;
  const dir = compassLabels(16)[Math.round(cam.heading / 22.5) % 16];
  const corrected = Math.abs(offset.heading) >= 0.05 || Math.abs(offset.pitch) >= 0.05;
  sensorText.textContent =
    `${dir} ${cam.heading.toFixed(0)}°` +
    (corrected ? ` · ${t('sensor.corrected', { offset: fmtSigned(offset.heading) })}` : '') +
    (tracker.status === 'relative' ? ` · ${t('sensor.noCompass')}` : '');
}

/** Rauschanzeige im offenen Einstellungsblatt: zeigt, welche Achse zittert. */
const noiseEl = $<HTMLParagraphElement>('sensor-noise');
function updateNoise() {
  const n = sensorOn && panel.hidden === false ? tracker.noise : null;
  noiseEl.hidden = !n;
  if (n) noiseEl.textContent = t('settings.noise', { h: n.heading.toFixed(1), p: n.pitch.toFixed(1), r: n.roll.toFixed(1) });
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
  saveOffset();
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

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service Worker:', err));
}

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

// --- Sprache ----------------------------------------------------------------------

const langSel = $<HTMLSelectElement>('lang');
function applyLang(choice: Lang | 'auto') {
  setLang(choice === 'auto' ? detectLang() : choice);
  langSel.value = choice;
  applyDom();
  setStatus(baseStatus);
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
setStatus(() => t('status.ready'));

// Ort aus URL bzw. Vorgabe als Rückfall; standardmäßig GPS und Sensoren
const fromHash = readHash();
if (!fromHash) {
  applyPreset(PRESETS[0]);
  presetSel.value = '0';
}
resize();
// Sensoren nur auf Touch-Geräten; Desktop hat keine Lagesensoren
if (matchMedia('(pointer: coarse)').matches) startSensors();
void locate().then((err) => {
  if (err) setNotice('gps', () => t('gps.fallback', { err: err(), place: fromHash ? t('gps.placeFromLink') : PRESETS[0].name }));
  compute();
});
