import { deltaDeg, normalizeDeg } from './geo';
import { azimuthInView, projector, type Camera } from './projection';
import type { PanoramaResult, Peak } from './protocol';
import type { PathPoint } from './astro';
import type { NightSky } from './nightsky';

const DIST_CLASSES = 10;
const RAD = Math.PI / 180;
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

type RGB = [number, number, number];

/** Farben der Zeichnung; hell/dunkel nach Systemeinstellung. */
export interface Palette {
  skyTop: string;
  skyBottom: string;
  groundTop: string;
  groundBottom: string;
  /** Kammlinien: nah → fern (Luftperspektive). */
  lineNear: RGB;
  lineFar: RGB;
  scale: string;
  text: string;
  textMuted: string;
  halo: string;
  leader: string;
  accent: string;
  hidden: string;
  overviewBg: string;
  overviewFill: string;
  /** Tagesbahnen von Sonne und Mond. */
  sunPath: string;
  moonPath: string;
}

export const LIGHT: Palette = {
  skyTop: '#7aa6d6',
  skyBottom: '#e6eef6',
  groundTop: '#c3ccd5',
  groundBottom: '#959c95',
  lineNear: [58, 52, 46],
  lineFar: [140, 165, 192],
  scale: 'rgba(22,30,42,0.7)',
  text: '#121821',
  textMuted: 'rgba(18,24,33,0.62)',
  halo: 'rgba(255,255,255,0.82)',
  leader: 'rgba(18,24,33,0.45)',
  accent: '#d0402f',
  hidden: 'rgba(18,24,33,0.35)',
  overviewBg: 'rgba(230,238,246,0.85)',
  overviewFill: 'rgba(120,134,150,0.85)',
  sunPath: 'rgba(214, 140, 0, 0.9)',
  moonPath: 'rgba(90, 104, 128, 0.8)',
};

export const DARK: Palette = {
  skyTop: '#070b12',
  skyBottom: '#26364c',
  groundTop: '#141b24',
  groundBottom: '#0b0f14',
  lineNear: [214, 222, 232],
  lineFar: [70, 92, 120],
  scale: 'rgba(220,228,238,0.6)',
  text: '#edf2f7',
  textMuted: 'rgba(237,242,247,0.6)',
  halo: 'rgba(7,11,18,0.85)',
  leader: 'rgba(237,242,247,0.35)',
  accent: '#ff6b57',
  hidden: 'rgba(237,242,247,0.3)',
  overviewBg: 'rgba(16,22,32,0.85)',
  overviewFill: 'rgba(90,110,135,0.9)',
  sunPath: 'rgba(255, 201, 74, 0.8)',
  moonPath: 'rgba(214, 222, 238, 0.65)',
};

/** Über dem Kamerabild: hell mit dunklem Schatten, lesbar auf Himmel, Fels und Schnee. */
export const CAMERA: Palette = {
  ...DARK,
  lineNear: [255, 255, 255],
  lineFar: [215, 230, 255],
  scale: 'rgba(255,255,255,0.9)',
  text: '#ffffff',
  textMuted: 'rgba(255,255,255,0.85)',
  halo: 'rgba(0,0,0,0.55)',
  leader: 'rgba(255,255,255,0.75)',
  hidden: 'rgba(255,255,255,0.45)',
  sunPath: 'rgba(255, 201, 74, 0.9)',
  moonPath: 'rgba(230, 236, 248, 0.8)',
};

function mix(a: RGB, b: RGB, t: number): string {
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
}

export interface RenderOptions {
  palette: Palette;
  showHidden: boolean;
  /** Fadenkreuz in Bildmitte (Sensormodus). */
  crosshair: boolean;
  selectedPeakId: number | null;
  /** Gesuchter Gipfel: hervorgehoben, außerhalb des Bilds zeigt ein Pfeil die Drehrichtung. */
  targetPeakId: number | null;
  /** Unten freizuhaltender Bereich (px), z. B. Bedienleiste. */
  bottomInset: number;
  /** Freizuhaltender Bereich oben (px), z. B. für die Statuszeile. */
  topInset: number;
  /** Kamerabild darunter: keine Himmel-/Geländeflächen, Linien mit Schatten. */
  overlay: boolean;
  /** Anzeigename eines Gipfels (Sprache). */
  peakName: (p: Peak) => string;
  /** Himmelsrichtungen N, NO, … in der UI-Sprache. */
  compass: string[];
  /** Sonne und Mond (leer = nicht zeichnen). */
  sky: SkyBody[];
  /** Sterne, Sternbilder, Planeten (null = nicht geladen). */
  night: NightSky | null;
}

/** Sonne oder Mond zum Zeichnen: aktuelle Lage und Tagesbahn. */
export interface SkyBody {
  kind: 'sun' | 'moon';
  az: number;
  alt: number;
  /** Mond: beleuchteter Anteil und Richtung zur Sonne (für die Lichtseite). */
  fraction?: number;
  sunAz?: number;
  sunAlt?: number;
  /** Bahn des Tages (lokale Mitternacht bis Mitternacht). */
  path: PathPoint[];
}

export interface PlacedLabel {
  peak: Peak;
  x: number;
  y: number;
}

type Project = (az: number, el: number) => [number, number] | null;

export function renderView(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  pano: PanoramaResult | null,
  opts: RenderOptions,
): PlacedLabel[] {
  const { width: W, height: H } = cam;
  const pal = opts.palette;
  const proj = projector(cam);
  if (opts.overlay) {
    ctx.clearRect(0, 0, W, H);
    if (opts.night) drawNight(ctx, cam, pano, opts.night, proj);
    drawSky(ctx, cam, pano, opts.sky, proj, pal, opts.night?.fade ?? 0);
    if (pano) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 3;
      drawLines(ctx, cam, pano, proj, pal, 0.75);
      ctx.restore();
    }
  } else {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, pal.skyTop);
    sky.addColorStop(1, pal.skyBottom);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    if (opts.night && opts.night.fade > 0) {
      // Himmel nachts abdunkeln, auch im hellen Farbschema
      ctx.fillStyle = `rgba(5, 8, 16, ${0.9 * opts.night.fade})`;
      ctx.fillRect(0, 0, W, H);
    }
    if (opts.night) drawNight(ctx, cam, pano, opts.night, proj);
    drawSky(ctx, cam, pano, opts.sky, proj, pal, opts.night?.fade ?? 0);
    if (pano) {
      drawGround(ctx, cam, pano, proj, pal);
      drawLines(ctx, cam, pano, proj, pal);
    }
  }
  const scaleY = opts.topInset + 14;
  drawCompass(ctx, cam, proj, pal, scaleY, opts.compass);
  const placed = pano ? drawPeaks(ctx, cam, pano, opts, proj, scaleY + 26) : [];
  if (opts.crosshair) drawCrosshair(ctx, cam, pal);
  const target = opts.targetPeakId === null ? undefined : pano?.peaks.find((p) => p.id === opts.targetPeakId);
  if (target) drawTarget(ctx, cam, target, proj, pal, scaleY + 26, opts.bottomInset);
  return placed;
}

const SUN_COLOR = '#ffc94a';
const MOON_LIT = '#eef1f6';
const MOON_DARK = 'rgba(58, 66, 82, 0.9)';
/** Scheinbarer Radius von Sonne und Mond (Grad). */
const DISC_RADIUS = 0.266;

/** Sichtbar, wenn über der Gelände-Silhouette (ohne Panorama: über dem Horizont). */
function aboveTerrain(pano: PanoramaResult | null, az: number, alt: number): boolean {
  if (!pano) return alt > 0;
  const n = pano.horizon.length;
  return alt >= pano.horizon[Math.round(az / pano.azStep) % n];
}

/** Tagesbahnen mit Stundenmarken, dann die Scheiben; hinter dem Gelände ausgeblendet. */
function drawSky(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  pano: PanoramaResult | null,
  bodies: SkyBody[],
  proj: Project,
  pal: Palette,
  nightFade: number,
) {
  const pxPerDeg = cam.width / cam.hfov;
  ctx.save();
  for (const b of bodies) {
    const color = b.kind === 'sun' ? pal.sunPath : pal.moonPath;
    // Nachts tritt die Sonnenbahn hinter die Sterne zurück
    ctx.globalAlpha = b.kind === 'sun' ? 1 - 0.75 * nightFade : 1;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    let pen = false;
    for (const p of b.path) {
      const q = aboveTerrain(pano, p.az, p.alt) && azimuthInView(cam, p.az, 5) ? proj(p.az, p.alt) : null;
      if (!q) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(q[0], q[1]);
      else ctx.moveTo(q[0], q[1]);
      pen = true;
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // Volle Stunden: Punkt und Uhrzeit
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const p of b.path) {
      const d = new Date(p.t);
      if (d.getMinutes() !== 0 || !aboveTerrain(pano, p.az, p.alt) || !azimuthInView(cam, p.az, 1)) continue;
      const q = proj(p.az, p.alt);
      if (!q) continue;
      ctx.beginPath();
      ctx.arc(q[0], q[1], 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = pal.halo;
      ctx.strokeText(String(d.getHours()), q[0], q[1] - 5);
      ctx.fillText(String(d.getHours()), q[0], q[1] - 5);
    }
  }
  ctx.globalAlpha = 1;
  for (const b of bodies) {
    if (!aboveTerrain(pano, b.az, b.alt) || !azimuthInView(cam, b.az, 2)) continue;
    const q = proj(b.az, b.alt);
    if (!q) continue;
    const r = Math.max(7, DISC_RADIUS * pxPerDeg);
    if (b.kind === 'sun') {
      const glow = ctx.createRadialGradient(q[0], q[1], r * 0.6, q[0], q[1], r * 3);
      glow.addColorStop(0, 'rgba(255, 210, 90, 0.55)');
      glow.addColorStop(1, 'rgba(255, 210, 90, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(q[0], q[1], r * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = SUN_COLOR;
      ctx.beginPath();
      ctx.arc(q[0], q[1], r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      drawMoon(ctx, b, q, r, proj);
    }
  }
  ctx.restore();
}

/** Sternfarbe aus dem Farbindex B−V. */
function starColor(bv: number): string {
  return bv < 0 ? '#b4cbff' : bv < 0.5 ? '#f3f6ff' : bv < 1 ? '#fff0cf' : '#ffd0a0';
}

/** Sternbildlinien, Sterne nach Helligkeit, Namen, Planeten – hinter dem Gelände verdeckt. */
function drawNight(ctx: CanvasRenderingContext2D, cam: Camera, pano: PanoramaResult | null, night: NightSky, proj: Project) {
  const f = night.fade;
  if (f <= 0) return;
  const inView = (az: number, alt: number) => aboveTerrain(pano, az, alt) && azimuthInView(cam, az, 2);
  ctx.save();
  // Linien
  ctx.strokeStyle = `rgba(140, 170, 230, ${0.4 * f})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const L = night.lines;
  for (let k = 0; k < L.length; k += 4) {
    if (!inView(L[k], L[k + 1]) || !inView(L[k + 2], L[k + 3])) continue;
    const a = proj(L[k], L[k + 1]);
    const b = proj(L[k + 2], L[k + 3]);
    if (!a || !b) continue;
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
  }
  ctx.stroke();
  // Sterne: Größe und Deckkraft nach Helligkeit
  const P = night.pos;
  for (let i = 0; i < night.mag.length; i++) {
    const m = night.mag[i];
    if (m > night.magLimit) break; // nach Helligkeit sortiert
    if (!inView(P[2 * i], P[2 * i + 1])) continue;
    const q = proj(P[2 * i], P[2 * i + 1]);
    if (!q || q[0] < 0 || q[0] > cam.width || q[1] < 0 || q[1] > cam.height) continue;
    const r = Math.min(3.4, Math.max(0.7, 2.6 - 0.42 * m));
    ctx.globalAlpha = f * Math.min(1, Math.max(0.25, (night.magLimit - m) / 1.5 + 0.25));
    ctx.fillStyle = starColor(night.bv[i]);
    ctx.beginPath();
    ctx.arc(q[0], q[1], r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // Sternbildnamen
  ctx.font = `500 10.5px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = `rgba(170, 192, 235, ${0.75 * f})`;
  for (const l of night.labels) {
    if (!inView(l.az, l.alt)) continue;
    const q = proj(l.az, l.alt);
    if (q) ctx.fillText(l.text.toUpperCase(), q[0], q[1]);
  }
  // Planeten und helle Sterne mit Namen
  ctx.textAlign = 'left';
  ctx.font = `600 11px ${FONT}`;
  for (const o of night.objects) {
    if (o.mag > night.magLimit + (o.kind === 'planet' ? 1.5 : 0) || (o.kind === 'star' && o.mag > 1.6) || !inView(o.az, o.alt)) continue;
    const q = proj(o.az, o.alt);
    if (!q) continue;
    if (o.kind === 'planet') {
      ctx.fillStyle = `rgba(255, 236, 200, ${f})`;
      ctx.beginPath();
      ctx.arc(q[0], q[1], Math.min(4, Math.max(2, 2.8 - 0.4 * o.mag)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = o.kind === 'planet' ? `rgba(255, 220, 160, ${f})` : `rgba(225, 232, 250, ${0.85 * f})`;
    ctx.fillText(o.name, q[0] + 6, q[1] - 6);
  }
  ctx.restore();
}

/** Mond mit Phase: Lichtseite zeigt zur Sonne (auch wenn diese unter dem Horizont steht). */
function drawMoon(ctx: CanvasRenderingContext2D, b: SkyBody, q: [number, number], r: number, proj: Project) {
  // Bildschirmrichtung zur Sonne: kleiner Schritt auf dem Großkreis Mond → Sonne
  const vec = (az: number, alt: number) => [Math.cos(alt * RAD) * Math.sin(az * RAD), Math.cos(alt * RAD) * Math.cos(az * RAD), Math.sin(alt * RAD)];
  const m = vec(b.az, b.alt);
  const s = vec(b.sunAz ?? b.az, b.sunAlt ?? b.alt);
  const dot = m[0] * s[0] + m[1] * s[1] + m[2] * s[2];
  const d = s.map((v, i) => v - dot * m[i]);
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  const p2 = m.map((v, i) => v + (d[i] / len) * 0.01);
  const az2 = Math.atan2(p2[0], p2[1]) / RAD;
  const alt2 = Math.atan2(p2[2], Math.hypot(p2[0], p2[1])) / RAD;
  const q2 = proj(((az2 % 360) + 360) % 360, alt2);
  const angle = q2 ? Math.atan2(q2[1] - q[1], q2[0] - q[0]) : 0;
  const k = b.fraction ?? 1;
  const e = r * (2 * k - 1);
  ctx.save();
  ctx.translate(q[0], q[1]);
  ctx.rotate(angle);
  ctx.fillStyle = MOON_DARK;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  // Lichtseite: Halbkreis zur Sonne (+x), zurück entlang der Terminator-Ellipse
  ctx.shadowColor = 'rgba(230, 236, 250, 0.7)';
  ctx.shadowBlur = r * 0.8;
  ctx.fillStyle = MOON_LIT;
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
  if (e >= 0) ctx.ellipse(0, 0, Math.max(e, 0.01), r, 0, Math.PI / 2, (3 * Math.PI) / 2);
  else ctx.ellipse(0, 0, -e, r, 0, Math.PI / 2, -Math.PI / 2, true);
  ctx.fill();
  ctx.restore();
}

function visibleBins(cam: Camera, pano: PanoramaResult): number[] {
  const n = pano.horizon.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (azimuthInView(cam, i * pano.azStep, 3)) out.push(i);
  }
  out.sort((a, b) => deltaDeg(a * pano.azStep, cam.heading) - deltaDeg(b * pano.azStep, cam.heading));
  return out;
}

function drawGround(ctx: CanvasRenderingContext2D, cam: Camera, pano: PanoramaResult, proj: Project, pal: Palette) {
  const line: [number, number][] = [];
  for (const i of visibleBins(cam, pano)) {
    const p = proj(i * pano.azStep, pano.horizon[i]);
    if (p) line.push(p);
  }
  if (line.length < 2) return;
  // Polygon nach "unten" (rollkorrigiert) schließen
  const big = 4 * (cam.width + cam.height);
  const dx = -Math.sin(cam.roll * RAD) * big;
  const dy = Math.cos(cam.roll * RAD) * big;
  const first = line[0];
  const last = line[line.length - 1];
  ctx.beginPath();
  ctx.moveTo(first[0] + dx, first[1] + dy);
  for (const [x, y] of line) ctx.lineTo(x, y);
  ctx.lineTo(last[0] + dx, last[1] + dy);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, cam.height);
  g.addColorStop(0, pal.groundTop);
  g.addColorStop(1, pal.groundBottom);
  ctx.fillStyle = g;
  ctx.fill();
}

function drawLines(ctx: CanvasRenderingContext2D, cam: Camera, pano: PanoramaResult, proj: Project, pal: Palette, alpha = 1) {
  const { linePoints: pts, lineOffsets: off } = pano;
  const radius = pano.request.radius;
  // Nach Distanzklassen bündeln: ein Pfad je Klasse, fern zuerst
  const paths = Array.from({ length: DIST_CLASSES }, () => new Path2D());
  for (let l = 0; l + 1 < off.length; l++) {
    const a = off[l];
    const b = off[l + 1];
    if (b - a < 3) continue;
    let sum = 0;
    for (let k = a; k < b; k++) sum += pts[k * 3 + 2];
    const t = Math.sqrt(sum / (b - a) / radius);
    const path = paths[Math.min(DIST_CLASSES - 1, Math.floor(t * DIST_CLASSES))];
    let pen = false;
    for (let k = a; k < b; k++) {
      const az = pts[k * 3];
      const p = azimuthInView(cam, az, 3) ? proj(az, pts[k * 3 + 1]) : null;
      if (!p) {
        pen = false;
        continue;
      }
      if (pen) path.lineTo(p[0], p[1]);
      else path.moveTo(p[0], p[1]);
      pen = true;
    }
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalAlpha = alpha;
  for (let c = DIST_CLASSES - 1; c >= 0; c--) {
    const t = (c + 0.5) / DIST_CLASSES;
    ctx.strokeStyle = mix(pal.lineNear, pal.lineFar, t);
    ctx.lineWidth = 2 - 1.3 * t;
    ctx.stroke(paths[c]);
  }
  ctx.globalAlpha = 1;
}

/**
 * Gradskala als gerade Zeile auf Bildschirmhöhe `y`. x-Position aus der Projektion
 * auf Höhe der Blickachse (gerade Linie ohne Rolle; bei Rolle Näherung).
 */
function drawCompass(ctx: CanvasRenderingContext2D, cam: Camera, proj: Project, pal: Palette, y: number, compass: string[]) {
  // Schrittweite so, dass Beschriftungen mindestens ~52 px auseinanderliegen
  const pxPerDeg = cam.width / cam.hfov;
  const step = [1, 2, 5, 10, 15, 30, 45].find((s) => s * pxPerDeg >= 52) ?? 45;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = pal.scale;
  for (let a = 0; a < 360; a += step) {
    if (!azimuthInView(cam, a, 1)) continue;
    const p = proj(a, cam.pitch);
    if (!p || p[0] < 12 || p[0] > cam.width - 12) continue;
    const major = a % 45 === 0;
    ctx.font = `${major ? 600 : 400} 11px ${FONT}`;
    ctx.fillRect(p[0] - 0.5, y - (major ? 8 : 5), 1, major ? 8 : 5);
    ctx.fillText(major ? compass[a / 45] : `${a}°`, p[0], y + 3);
  }
}

function drawCrosshair(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette) {
  const x = cam.width / 2;
  const y = cam.height / 2;
  ctx.save();
  ctx.strokeStyle = pal.accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 12, 0, Math.PI * 2);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.moveTo(x + dx * 17, y + dy * 17);
    ctx.lineTo(x + dx * 26, y + dy * 26);
  }
  ctx.stroke();
  ctx.restore();
}

/** Drehrichtung zum Ziel: Grad nach rechts (+) bzw. links (−), oder 0 wenn waagrecht im Bild. */
export function turnToTarget(cam: Camera, az: number): number {
  const d = deltaDeg(az, cam.heading);
  return Math.abs(d) <= cam.hfov / 2 ? 0 : d;
}

/**
 * Ziel im Bild: Ring um den Gipfel. Außerhalb: Pfeil am Rand in Drehrichtung
 * (links/rechts, bzw. oben/unten wenn nur die Neigung fehlt) mit Gradzahl.
 */
function drawTarget(ctx: CanvasRenderingContext2D, cam: Camera, peak: Peak, proj: Project, pal: Palette, top: number, bottomInset: number) {
  const W = cam.width;
  const bottom = cam.height - bottomInset;
  const p = azimuthInView(cam, peak.az, 0) ? proj(peak.az, peak.angle) : null;
  ctx.save();
  if (p && p[0] >= 0 && p[0] <= W && p[1] >= top && p[1] <= bottom) {
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 13, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const r = 19;
  const m = r + 8;
  const d = deltaDeg(peak.az, cam.heading);
  let x: number;
  let y: number;
  let dir: number; // Pfeilrichtung (rad, 0 = rechts)
  let deg: number;
  if (p && p[0] >= 0 && p[0] <= W) {
    const up = p[1] < top;
    x = Math.min(W - m, Math.max(m, p[0]));
    y = up ? top + m : bottom - m;
    dir = up ? -Math.PI / 2 : Math.PI / 2;
    deg = Math.abs(peak.angle - cam.pitch);
  } else {
    x = d > 0 ? W - m : m;
    y = Math.min(bottom - m, Math.max(top + m, p ? p[1] : cam.height / 2));
    dir = d > 0 ? 0 : Math.PI;
    deg = Math.abs(d);
  }
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 8;
  ctx.fillStyle = pal.accent;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.translate(x, y);
  ctx.fillStyle = '#fff';
  ctx.font = `700 11px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${Math.round(deg)}°`, 0, 0.5);
  // Pfeilspitze außen am Kreis
  ctx.rotate(dir);
  ctx.beginPath();
  ctx.moveTo(r + 7, 0);
  ctx.lineTo(r - 1, -7);
  ctx.lineTo(r - 1, 7);
  ctx.closePath();
  ctx.fillStyle = pal.accent;
  ctx.fill();
  ctx.restore();
}

/**
 * Bekanntheit eines Gipfels fürs Ausdünnen der Labels: Wikipedia-Sprachversionen
 * (≥ 64 ≈ Matterhorn zählt voll), Hervortreten über die Silhouette, Höhe.
 */
export function labelScore(p: Peak): number {
  const fame = Math.min(1, Math.log2(1 + p.fame) / 6);
  const relief = Math.min(1, p.relief / 1.5);
  return 1.5 * fame + relief + (0.5 * p.ele) / 4000;
}

function drawPeaks(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  pano: PanoramaResult,
  opts: RenderOptions,
  proj: Project,
  labelTop: number,
): PlacedLabel[] {
  const pal = opts.palette;
  const cands: PlacedLabel[] = [];
  for (const peak of pano.peaks) {
    const selected = peak.id === opts.selectedPeakId || peak.id === opts.targetPeakId;
    if (!peak.visible && !opts.showHidden && !selected) continue;
    if (!azimuthInView(cam, peak.az, 1)) continue;
    const p = proj(peak.az, peak.angle);
    if (!p || p[0] < -20 || p[0] > cam.width + 20 || p[1] < labelTop || p[1] > cam.height) continue;
    cands.push({ peak, x: p[0], y: p[1] });
  }
  // Priorität: ausgewählt, sichtbar vor verdeckt, dann Bekanntheit
  const rank = (l: PlacedLabel) =>
    l.peak.id === opts.selectedPeakId || l.peak.id === opts.targetPeakId ? 2 : l.peak.visible ? 1 : 0;
  cands.sort((a, b) => rank(b) - rank(a) || labelScore(b.peak) - labelScore(a.peak));
  const placed: PlacedLabel[] = [];
  const minGap = 18;
  for (const c of cands) {
    if (placed.every((p) => Math.abs(p.x - c.x) >= minGap)) placed.push(c);
  }

  const nameFont = `600 13px ${FONT}`;
  const metaFont = `400 11px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const { peak, x, y } of placed) {
    const selected = peak.id === opts.selectedPeakId || peak.id === opts.targetPeakId;
    const name = opts.peakName(peak);
    const meta = `${Math.round(peak.ele)} m · ${(peak.dist / 1000).toFixed(peak.dist < 10_000 ? 1 : 0)} km`;
    ctx.font = nameFont;
    const wName = ctx.measureText(name).width;
    ctx.font = metaFont;
    const wMeta = ctx.measureText(meta).width;
    const len = wName + 6 + wMeta;
    // Text oben bündig (liest von unten nach oben); Leitlinie vom Gipfel bis zum Textende
    const top = Math.max(labelTop + 10, Math.min(y - 10, labelTop + len + 4));
    ctx.strokeStyle = selected ? pal.accent : peak.visible ? pal.leader : pal.hidden;
    ctx.lineWidth = selected ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, y - 4);
    ctx.lineTo(x + 0.5, top);
    ctx.stroke();
    ctx.fillStyle = peak.visible || selected ? pal.accent : pal.hidden;
    ctx.beginPath();
    ctx.arc(x, y, selected ? 4.5 : 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(x, top - 4);
    ctx.rotate(-Math.PI / 2);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = pal.halo;
    ctx.font = nameFont;
    ctx.strokeText(name, 0, 0);
    ctx.fillStyle = selected ? pal.accent : peak.visible ? pal.text : pal.hidden;
    ctx.fillText(name, 0, 0);
    ctx.font = metaFont;
    ctx.strokeText(meta, wName + 6, 0.5);
    ctx.fillStyle = peak.visible || selected ? pal.textMuted : pal.hidden;
    ctx.fillText(meta, wName + 6, 0.5);
    ctx.restore();
  }
  return placed;
}

/** 360°-Übersichtsstreifen (äquirektangulär) mit Markierung des Sichtfelds. */
export function renderOverview(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  cam: Camera,
  pano: PanoramaResult | null,
  pal: Palette,
  compass: string[],
  targetAz: number | null = null,
) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = pal.overviewBg;
  ctx.fillRect(0, 0, W, H);
  if (pano) {
    const n = pano.horizon.length;
    let lo = Infinity;
    let hi = -Infinity;
    for (const a of pano.horizon) {
      lo = Math.min(lo, a);
      hi = Math.max(hi, a);
    }
    const pad = Math.max(0.5, (hi - lo) * 0.15);
    lo -= pad;
    hi += pad;
    const y = (a: number) => H - ((a - lo) / (hi - lo)) * H;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < n; i++) ctx.lineTo((i / n) * W, y(pano.horizon[i]));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = pal.overviewFill;
    ctx.fill();
  }
  // Sichtfeld
  const x0 = (normalizeDeg(cam.heading - cam.hfov / 2) / 360) * W;
  const w = (cam.hfov / 360) * W;
  ctx.strokeStyle = pal.accent;
  ctx.lineWidth = 1.5;
  for (const off of [0, -W]) {
    ctx.strokeRect(x0 + off + 0.75, 0.75, w - 1.5, H - 1.5);
  }
  // Ziel der Suche: Dreieck am unteren Rand
  if (targetAz !== null) {
    const tx = (normalizeDeg(targetAz) / 360) * W;
    ctx.fillStyle = pal.accent;
    ctx.beginPath();
    ctx.moveTo(tx, H - 9);
    ctx.lineTo(tx - 5, H);
    ctx.lineTo(tx + 5, H);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = pal.scale;
  ctx.font = `600 10px ${FONT}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (let k = 0; k < 8; k++) ctx.fillText(compass[k], ((k * 45) / 360) * W + (k === 0 ? 8 : 0), 3);
}
