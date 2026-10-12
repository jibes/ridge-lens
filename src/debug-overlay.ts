/**
 * Diagnose-Overlay: erkannte Horizontlinien, Himmelsmaske und alle Kennzahlen direkt im Bild,
 * damit ein einzelner Screenshot zur Fehlersuche reicht.
 */

export interface DebugDraw {
  /** Horizont aus der Himmelsmaske (KI), Bildschirmpunkte; null = Lücke. */
  segLine: ([number, number] | null)[];
  /** Horizont aus Farbkanten. */
  colorLine: ([number, number] | null)[];
  /** aspect: Höhe des Streifens als Anteil der Bildhöhe. */
  mask: { size: number; data: Uint8Array; aspect: number } | null;
  lines: string[];
  /** Erwartete Turmspitzen (Bildschirmpunkt, Name). */
  towers: { p: [number, number]; name: string }[];
  /** Streifen der Himmelserkennung (Bildschirmzeilen oben/unten). */
  band: [number, number] | null;
  /** Platz unten (Dock) und oben (Statuszeile), CSS-Pixel. */
  bottomInset: number;
  topInset: number;
}

const maskCanvas = document.createElement('canvas');

function polyline(ctx: CanvasRenderingContext2D, pts: ([number, number] | null)[], color: string, width: number, dash: number[]) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let open = false;
  for (const p of pts) {
    if (!p) {
      open = false;
      continue;
    }
    if (open) ctx.lineTo(p[0], p[1]);
    else ctx.moveTo(p[0], p[1]);
    open = true;
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

export function drawDebug(ctx: CanvasRenderingContext2D, width: number, height: number, d: DebugDraw): void {
  ctx.save();
  // Farbkanten gelb gestrichelt unter der KI-Linie (cyan), damit Abweichungen auffallen
  polyline(ctx, d.colorLine, 'rgba(0,0,0,0.6)', 4, [6, 4]);
  polyline(ctx, d.colorLine, '#ffd400', 2, [6, 4]);
  if (d.band) {
    for (const y of d.band) polyline(ctx, [[0, y], [width, y]], 'rgba(255,255,255,0.7)', 1, [2, 6]);
  }
  // Türme: kleines Dreieck an der erwarteten Spitze
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
  for (const tw of d.towers) {
    const [x, y] = tw.p;
    ctx.fillStyle = '#ff8c00';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 4, y - 7);
    ctx.lineTo(x + 4, y - 7);
    ctx.closePath();
    ctx.fill();
    if (tw.name) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x + 5, y - 18, ctx.measureText(tw.name).width + 4, 12);
      ctx.fillStyle = '#ffb45a';
      ctx.fillText(tw.name, x + 7, y - 16);
    }
  }
  polyline(ctx, d.segLine, 'rgba(0,0,0,0.6)', 4, []);
  polyline(ctx, d.segLine, '#00e5ff', 2, []);

  const font = 10;
  const lh = font + 2.5;
  ctx.font = `${font}px ui-monospace, Menlo, Consolas, monospace`;
  const pad = 5;
  const maskW = d.mask ? Math.min(84, width * 0.2) : 0;
  const maskH = d.mask ? (maskW * height * d.mask.aspect) / width : 0;
  const boxW = width - 12;
  // Zeilen umbrechen (an Trennzeichen „ · “ bzw. Leerzeichen), nichts abschneiden; neben der Maske schmaler
  const wrapped: string[] = [];
  const widthAt = (i: number) => boxW - 2 * pad - (i * lh < maskH + 4 ? maskW + 6 : 0);
  for (const line of d.lines) {
    const indent = /^\s*/.exec(line)![0] + '  ';
    let rest = line;
    while (rest) {
      const max = widthAt(wrapped.length);
      if (ctx.measureText(rest).width <= max) {
        wrapped.push(rest);
        break;
      }
      let cut = rest.length;
      while (cut > 1 && ctx.measureText(rest.slice(0, cut)).width > max) cut--;
      const sep = Math.max(rest.lastIndexOf(' · ', cut), rest.lastIndexOf(' ', cut));
      if (sep > indent.length) cut = sep;
      wrapped.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^( · | )/, '');
      if (rest) rest = indent + rest;
    }
  }
  const boxH = Math.max(wrapped.length * lh + 2 * pad, maskH);
  const y0 = Math.max(d.topInset + 4, height - d.bottomInset - boxH - 4);
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(6, y0, boxW, boxH);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  wrapped.forEach((s, i) => ctx.fillText(s, 6 + pad, y0 + pad + i * lh));
  if (d.mask) {
    // Himmelsmaske, gestaucht auf das Bildseitenverhältnis: Himmel hell, Gelände dunkel
    const { size, data } = d.mask;
    maskCanvas.width = maskCanvas.height = size;
    const mctx = maskCanvas.getContext('2d')!;
    const img = mctx.createImageData(size, size);
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      img.data.set([v * 0.2, v * 0.85, v, 255], i * 4);
    }
    mctx.putImageData(img, 0, 0);
    const mx = width - 6 - maskW;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(maskCanvas, mx, y0, maskW, maskH);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(mx + 0.5, y0 + 0.5, maskW - 1, maskH - 1);
  }
  ctx.restore();
}
