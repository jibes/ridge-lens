import { deltaDeg, normalizeDeg } from './geo';
import { azimuthInView, projector, type Camera } from './projection';
import type { PanoramaResult, Peak } from './protocol';

const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
const DIST_CLASSES = 10;
const RAD = Math.PI / 180;

/** Farbe nach Distanz: nah dunkel/warm, fern hell/blau (Luftperspektive). */
function distColor(t: number, alpha = 1): string {
  const near = [62, 52, 40];
  const far = [150, 175, 205];
  const c = near.map((n, i) => Math.round(n + (far[i] - n) * t));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

export interface RenderOptions {
  showHidden: boolean;
  /** Fadenkreuz in Bildmitte (Sensormodus). */
  crosshair: boolean;
  selectedPeakId: number | null;
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
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#6f9fd8');
  sky.addColorStop(1, '#dfe9f3');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  const proj = projector(cam);
  if (pano) {
    drawGround(ctx, cam, pano, proj);
    drawLines(ctx, cam, pano, proj);
  }
  drawCompass(ctx, cam, proj);
  const placed = pano ? drawPeaks(ctx, cam, pano, opts, proj) : [];
  if (opts.crosshair) drawCrosshair(ctx, cam);
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

function drawGround(ctx: CanvasRenderingContext2D, cam: Camera, pano: PanoramaResult, proj: Project) {
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
  g.addColorStop(0, '#b9c4cf');
  g.addColorStop(1, '#8b8f86');
  ctx.fillStyle = g;
  ctx.fill();
}

function drawLines(ctx: CanvasRenderingContext2D, cam: Camera, pano: PanoramaResult, proj: Project) {
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
  for (let c = DIST_CLASSES - 1; c >= 0; c--) {
    const t = (c + 0.5) / DIST_CLASSES;
    ctx.strokeStyle = distColor(t);
    ctx.lineWidth = 2.2 - 1.4 * t;
    ctx.stroke(paths[c]);
  }
}

function drawCompass(ctx: CanvasRenderingContext2D, cam: Camera, proj: Project) {
  // Schrittweite so, dass Beschriftungen mindestens ~48 px auseinanderliegen
  const pxPerDeg = cam.width / cam.hfov;
  const step = [1, 2, 5, 10, 15, 30, 45].find((s) => s * pxPerDeg >= 48) ?? 45;
  // Skala knapp unter dem oberen Bildrand, entlang konstanter Höhe
  const vhalf = Math.atan((Math.tan((cam.hfov / 2) * RAD) * cam.height) / cam.width) / RAD;
  const el = cam.pitch + vhalf * 0.93;
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(20,30,45,0.8)';
  for (let a = 0; a < 360; a += step) {
    if (!azimuthInView(cam, a, 1)) continue;
    const p = proj(a, el);
    if (!p) continue;
    const major = a % 45 === 0;
    ctx.fillRect(p[0] - 0.5, p[1] - (major ? 12 : 6), 1, major ? 12 : 6);
    ctx.fillText(major ? COMPASS[a / 45] : `${a}°`, p[0], p[1] + 2);
  }
}

function drawCrosshair(ctx: CanvasRenderingContext2D, cam: Camera) {
  const x = cam.width / 2;
  const y = cam.height / 2;
  ctx.save();
  ctx.strokeStyle = 'rgba(192,57,43,0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.moveTo(x + dx * 6, y + dy * 6);
    ctx.lineTo(x + dx * 24, y + dy * 24);
  }
  ctx.stroke();
  ctx.restore();
}

function drawPeaks(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  pano: PanoramaResult,
  opts: RenderOptions,
  proj: Project,
): PlacedLabel[] {
  const cands: PlacedLabel[] = [];
  for (const peak of pano.peaks) {
    const selected = peak.id === opts.selectedPeakId;
    if (!peak.visible && !opts.showHidden && !selected) continue;
    if (!azimuthInView(cam, peak.az, 1)) continue;
    const p = proj(peak.az, peak.angle);
    if (!p || p[0] < -20 || p[0] > cam.width + 20 || p[1] < 0 || p[1] > cam.height) continue;
    cands.push({ peak, x: p[0], y: p[1] });
  }
  // Priorität: ausgewählt, sichtbar vor verdeckt, dann Höhe
  const rank = (l: PlacedLabel) => (l.peak.id === opts.selectedPeakId ? 2 : l.peak.visible ? 1 : 0);
  cands.sort((a, b) => rank(b) - rank(a) || b.peak.ele - a.peak.ele);
  const placed: PlacedLabel[] = [];
  const minGap = 15;
  for (const c of cands) {
    if (placed.every((p) => Math.abs(p.x - c.x) >= minGap)) placed.push(c);
  }

  const labelTop = 54;
  ctx.font = '13px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const { peak, x, y } of placed) {
    const selected = peak.id === opts.selectedPeakId;
    const text = `${peak.name}  ${Math.round(peak.ele)} m · ${(peak.dist / 1000).toFixed(peak.dist < 10_000 ? 1 : 0)} km`;
    // Text oben bündig; Leitlinie vom Gipfel bis zum Textende
    const top = Math.max(labelTop + 10, Math.min(y - 12, labelTop + ctx.measureText(text).width + 4));
    ctx.strokeStyle = selected ? '#c0392b' : peak.visible ? 'rgba(20,25,35,0.7)' : 'rgba(20,25,35,0.25)';
    ctx.lineWidth = selected ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, y - 3);
    ctx.lineTo(x + 0.5, top);
    ctx.stroke();
    ctx.fillStyle = peak.visible || selected ? '#c0392b' : 'rgba(80,80,80,0.5)';
    ctx.beginPath();
    ctx.arc(x, y, selected ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(x, top - 4);
    ctx.rotate(-Math.PI / 2);
    ctx.font = selected ? 'bold 13px system-ui, sans-serif' : '13px system-ui, sans-serif';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = selected ? '#a5281b' : peak.visible ? '#141a24' : 'rgba(20,26,36,0.45)';
    ctx.fillText(text, 0, 0);
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
) {
  ctx.fillStyle = '#dfe9f3';
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
    ctx.fillStyle = '#8f9aa5';
    ctx.fill();
  }
  // Sichtfeld
  const x0 = (normalizeDeg(cam.heading - cam.hfov / 2) / 360) * W;
  const w = (cam.hfov / 360) * W;
  ctx.fillStyle = 'rgba(192,57,43,0.18)';
  ctx.strokeStyle = 'rgba(192,57,43,0.9)';
  for (const off of [0, -W]) {
    ctx.fillRect(x0 + off, 0, w, H);
    ctx.strokeRect(x0 + off + 0.5, 0.5, w - 1, H - 1);
  }
  ctx.fillStyle = 'rgba(20,30,45,0.8)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (let k = 0; k < 8; k++) ctx.fillText(COMPASS[k], ((k * 45) / 360) * W + (k === 0 ? 8 : 0), 2);
}
