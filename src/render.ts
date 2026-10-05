import { deltaDeg, normalizeDeg } from './geo';
import { azimuthInView, projector, type Camera } from './projection';
import type { PanoramaResult, Peak } from './protocol';

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
  /** Freizuhaltender Bereich oben (px), z. B. für die Statuszeile. */
  topInset: number;
  /** Kamerabild darunter: keine Himmel-/Geländeflächen, Linien mit Schatten. */
  overlay: boolean;
  /** Anzeigename eines Gipfels (Sprache). */
  peakName: (p: Peak) => string;
  /** Himmelsrichtungen N, NO, … in der UI-Sprache. */
  compass: string[];
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
    if (pano) {
      drawGround(ctx, cam, pano, proj, pal);
      drawLines(ctx, cam, pano, proj, pal);
    }
  }
  const scaleY = opts.topInset + 14;
  drawCompass(ctx, cam, proj, pal, scaleY, opts.compass);
  const placed = pano ? drawPeaks(ctx, cam, pano, opts, proj, scaleY + 26) : [];
  if (opts.crosshair) drawCrosshair(ctx, cam, pal);
  return placed;
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
    const selected = peak.id === opts.selectedPeakId;
    if (!peak.visible && !opts.showHidden && !selected) continue;
    if (!azimuthInView(cam, peak.az, 1)) continue;
    const p = proj(peak.az, peak.angle);
    if (!p || p[0] < -20 || p[0] > cam.width + 20 || p[1] < labelTop || p[1] > cam.height) continue;
    cands.push({ peak, x: p[0], y: p[1] });
  }
  // Priorität: ausgewählt, sichtbar vor verdeckt, dann Bekanntheit
  const rank = (l: PlacedLabel) => (l.peak.id === opts.selectedPeakId ? 2 : l.peak.visible ? 1 : 0);
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
    const selected = peak.id === opts.selectedPeakId;
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
  ctx.fillStyle = pal.scale;
  ctx.font = `600 10px ${FONT}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (let k = 0; k < 8; k++) ctx.fillText(compass[k], ((k * 45) / 360) * W + (k === 0 ? 8 : 0), 3);
}
