import { deltaDeg, normalizeDeg } from './geo';
import { project, type Camera } from './projection';
import type { PanoramaResult, Peak } from './protocol';

const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
const DIST_CLASSES = 10;

/** Farbe nach Distanz: nah dunkel/warm, fern hell/blau (Luftperspektive). */
function distColor(t: number, alpha = 1): string {
  const near = [62, 52, 40];
  const far = [150, 175, 205];
  const c = near.map((n, i) => Math.round(n + (far[i] - n) * t));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

export interface RenderOptions {
  showHidden: boolean;
}

export interface PlacedLabel {
  peak: Peak;
  x: number;
  y: number;
}

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

  if (pano) {
    drawGround(ctx, cam, pano);
    drawLines(ctx, cam, pano);
  }
  drawCompass(ctx, cam);
  return pano ? drawPeaks(ctx, cam, pano, opts) : [];
}

function visibleBins(cam: Camera, pano: PanoramaResult): number[] {
  const n = pano.horizon.length;
  const half = Math.min(89, cam.hfov / 2 + 2);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Math.abs(deltaDeg(i * pano.azStep, cam.heading)) <= half) out.push(i);
  }
  out.sort((a, b) => deltaDeg(a * pano.azStep, cam.heading) - deltaDeg(b * pano.azStep, cam.heading));
  return out;
}

function drawGround(ctx: CanvasRenderingContext2D, cam: Camera, pano: PanoramaResult) {
  const bins = visibleBins(cam, pano);
  ctx.beginPath();
  let started = false;
  let lastX = 0;
  for (const i of bins) {
    const p = project(cam, i * pano.azStep, pano.horizon[i]);
    if (!p) continue;
    if (!started) {
      ctx.moveTo(p[0], cam.height);
      started = true;
    }
    ctx.lineTo(p[0], p[1]);
    lastX = p[0];
  }
  if (!started) return;
  ctx.lineTo(lastX, cam.height);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, cam.height);
  g.addColorStop(0, '#b9c4cf');
  g.addColorStop(1, '#8b8f86');
  ctx.fillStyle = g;
  ctx.fill();
}

function drawLines(ctx: CanvasRenderingContext2D, cam: Camera, pano: PanoramaResult) {
  const { linePoints: pts, lineOffsets: off } = pano;
  const radius = pano.request.radius;
  const half = Math.min(89, cam.hfov / 2 + 2);
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
      if (Math.abs(deltaDeg(az, cam.heading)) > half) {
        pen = false;
        continue;
      }
      const p = project(cam, az, pts[k * 3 + 1]);
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

function drawCompass(ctx: CanvasRenderingContext2D, cam: Camera) {
  const step = cam.hfov > 60 ? 10 : cam.hfov > 25 ? 5 : 1;
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let a = 0; a < 360; a += step) {
    const d = deltaDeg(a, cam.heading);
    if (Math.abs(d) > cam.hfov / 2 + 1) continue;
    const p = project(cam, a, cam.pitch);
    if (!p) continue;
    const major = a % 45 === 0;
    ctx.fillStyle = 'rgba(20,30,45,0.8)';
    ctx.fillRect(p[0] - 0.5, 0, 1, major ? 12 : 6);
    if (major || step <= 5 || a % 30 === 0) {
      ctx.fillText(major ? COMPASS[a / 45] : `${a}°`, p[0], 14);
    }
  }
}

function drawPeaks(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  pano: PanoramaResult,
  opts: RenderOptions,
): PlacedLabel[] {
  const cands: PlacedLabel[] = [];
  for (const peak of pano.peaks) {
    if (!peak.visible && !opts.showHidden) continue;
    if (Math.abs(deltaDeg(peak.az, cam.heading)) > cam.hfov / 2 + 1) continue;
    const p = project(cam, peak.az, peak.angle);
    if (!p || p[1] < 0 || p[1] > cam.height) continue;
    cands.push({ peak, x: p[0], y: p[1] });
  }
  // Priorität: sichtbar vor verdeckt, dann Höhe
  cands.sort((a, b) => Number(b.peak.visible) - Number(a.peak.visible) || b.peak.ele - a.peak.ele);
  const placed: PlacedLabel[] = [];
  const minGap = 15;
  for (const c of cands) {
    if (placed.every((p) => Math.abs(p.x - c.x) >= minGap)) placed.push(c);
  }

  const labelTop = 34;
  ctx.font = '13px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const { peak, x, y } of placed) {
    const text = `${peak.name}  ${Math.round(peak.ele)} m · ${(peak.dist / 1000).toFixed(peak.dist < 10_000 ? 1 : 0)} km`;
    // Text oben bündig; Leitlinie vom Gipfel bis zum Textende
    const top = Math.max(labelTop + 10, Math.min(y - 12, labelTop + ctx.measureText(text).width + 4));
    ctx.strokeStyle = peak.visible ? 'rgba(20,25,35,0.7)' : 'rgba(20,25,35,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, y - 3);
    ctx.lineTo(x + 0.5, top);
    ctx.stroke();
    ctx.fillStyle = peak.visible ? '#c0392b' : 'rgba(80,80,80,0.5)';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(x, top - 4);
    ctx.rotate(-Math.PI / 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = peak.visible ? '#141a24' : 'rgba(20,26,36,0.45)';
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
