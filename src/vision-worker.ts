/// <reference lib="webworker" />
// Bildabgleich im Hintergrund, damit die Anzeige flüssig bleibt.
import type { Camera } from './projection';
import type { Landmark } from './protocol';
import { SkyNet, SKYNET_SIZE, stretchContrast, type SkyNetModel } from './skynet';
import { SkylineAccumulator, detectSpikes, matchLandmarks, skylineEvaluator, treeTolerance, detectBody, detectStars, matchStars, type StarRef, extractSkyline, extractSkylineSeg, matchPitch, matchSkylineHaze, searchWindows, type BodyTarget, type MatchResult } from './vision';

export type VisionRequest =
  | { type: 'landmarks'; landmarks: Landmark[] }
  | { type: 'horizon'; horizon: Float32Array; haze: Float32Array[]; azStep: number; dist: Float32Array; hazeDist: Float32Array[] }
  | {
      type: 'frame';
      id: number;
      pixels: Uint8ClampedArray;
      cols: number;
      rows: number;
      cam: Camera;
      bodies: BodyTarget[];
      /** Korrekturen, die in `cam` stecken (für das Rundumprofil herausgerechnet). */
      offHeading: number;
      offPitch: number;
      /** Gerät wird geschwenkt: Bild nur fürs Rundumprofil sammeln. */
      moving: boolean;
      /** Nachts: Bild in höherer Auflösung (Sterne sind punktförmig) und Sterne/Planeten im Blickfeld. */
      stars?: { pixels: Uint8ClampedArray; cols: number; rows: number; refs: StarRef[] };
      /** Tagsüber: Streifen um den erwarteten Horizont auf SKYNET_SIZE² gestaucht, für die Himmelserkennung. */
      seg?: Uint8ClampedArray;
      /** Lage des Streifens als Anteil der Bildhöhe [oben, unten]. */
      segBand?: [number, number];
      /** Derselbe Streifen in voller Breite unverzerrt (Türme sind dünner als die Maske auflöst). */
      towerStrip?: { pixels: Uint8ClampedArray; w: number; h: number };
      /** Diagnose-Overlay: Zwischenergebnisse mitschicken. */
      debug?: boolean;
    };

/** Diagnose: erkannte Kanten (Zeile je Spalte, NaN = keine), Maske, Ergebnis jeder Stufe. */
export interface VisionDebug {
  method: 'seg' | 'color';
  net: 'idle' | 'loading' | 'failed' | 'ready';
  colorY: Float32Array;
  segY?: Float32Array;
  /** Himmelsmaske, 0–255, `maskSize`², über den Streifen `maskBand` (Anteil der Bildhöhe). */
  mask?: Uint8Array;
  maskSize?: number;
  maskBand?: [number, number];
  steps: string[];
}

export interface VisionResponse {
  id: number;
  cam: Camera;
  match: MatchResult;
  /** Woran ausgerichtet wurde; Sonne/Mond liefern keinen Bildwinkel. */
  source: 'skyline' | 'pitch' | 'pano' | 'stars' | 'tower' | BodyTarget['kind'];
  /** Himmelserkennung lief (ms), sonst Farbkanten. */
  segMs?: number;
  /** Abgedeckter Winkel des Rundumprofils (°, letzte 90 s). */
  panoCoverage?: number;
  debug?: VisionDebug;
}

declare const self: DedicatedWorkerGlobalScope;
let horizon: Float32Array | null = null;
let haze: Float32Array[] = [];
/** Waldtoleranz je Modell (volle Silhouette, dann Dunst-Silhouetten). */
let tols: Float32Array[] = [];
let azStep = 0.1;
const acc = new SkylineAccumulator();
/** Türme über dem Horizont (vom Panorama-Worker über den Hauptthread). */
let landmarks: Landmark[] = [];

/** Himmelserkennung, beim ersten Tagbild nachgeladen; schlägt das fehl, bleibt es bei den Farbkanten. */
let net: SkyNet | null = null;
let netState: 'idle' | 'loading' | 'failed' = 'idle';
function loadNet() {
  netState = 'loading';
  // Relativ zum Worker-Skript (assets/ bzw. src/); import.meta.url würde Vite als Asset-Muster umschreiben
  const url = (f: string) => new URL(`../models/${f}`, self.location.href);
  Promise.all([fetch(url('skynet.json')).then((r) => r.json()), fetch(url('skynet.bin')).then((r) => r.arrayBuffer())])
    .then(([model, bin]: [SkyNetModel, ArrayBuffer]) => {
      net = new SkyNet(model, new Float32Array(bin));
    })
    .catch(() => {
      netState = 'failed';
    });
}

self.onmessage = (ev: MessageEvent<VisionRequest>) => {
  const msg = ev.data;
  if (msg.type === 'landmarks') {
    landmarks = msg.landmarks;
    return;
  }
  if (msg.type === 'horizon') {
    horizon = msg.horizon;
    haze = msg.haze;
    tols = [treeTolerance(msg.dist), ...msg.hazeDist.map((d) => treeTolerance(d))];
    azStep = msg.azStep;
    acc.clear();
    return;
  }
  if (!horizon) return;
  const { pixels, cols, rows, cam } = msg;
  // Auch um den rohen Kompass suchen (eine falsch gelernte Korrektur nicht festschreiben)
  const centers = Math.abs(msg.offHeading) > 3 ? [0, -msg.offHeading] : [0];
  const windows = searchWindows(cam, horizon, azStep, cols, rows, 20 + (centers.length > 1 ? Math.abs(msg.offHeading) : 0));
  let sky = null;
  let segMs: number | undefined;
  let mask: { size: number; prob: Float32Array } | null = null;
  if (msg.seg) {
    if (net) {
      const t0 = performance.now();
      stretchContrast(msg.seg);
      mask = net.segment(msg.seg, SKYNET_SIZE, SKYNET_SIZE);
      const band = msg.segBand ?? [0, 1];
      sky = extractSkylineSeg(pixels, cols, rows, windows, mask.prob, mask.size, [band[0] * rows, band[1] * rows]);
      segMs = performance.now() - t0;
    } else if (netState === 'idle') loadNet();
  }
  const color = sky && !msg.debug ? null : extractSkyline(pixels, cols, rows, windows);
  sky ??= color!;
  const dbg: VisionDebug | undefined = msg.debug
    ? {
        method: mask ? 'seg' : 'color',
        net: net ? 'ready' : netState,
        colorY: color!.y,
        segY: mask ? sky.y : undefined,
        mask: mask ? Uint8Array.from(mask.prob, (v) => Math.round(v * 255)) : undefined,
        maskSize: mask?.size,
        maskBand: mask ? (msg.segBand ?? [0, 1]) : undefined,
        steps: [],
      }
    : undefined;
  const step = (s: string) => dbg?.steps.push(s);
  const fmt = (m: MatchResult) =>
    m.ok
      ? `✓ dH ${m.dHeading.toFixed(2)} dP ${m.dPitch.toFixed(2)} fov×${m.fovScale.toFixed(3)} c ${m.cost.toFixed(3)}`
      : `✗ ${m.reason ?? ''}${Number.isFinite(m.cost) ? ` c ${m.cost.toFixed(3)} (beste dH ${m.dHeading.toFixed(2)} dP ${m.dPitch.toFixed(2)})` : ''}`;
  const points: { x: number; y: number }[] = [];
  for (let c = 0; c < cols; c++) {
    if (!Number.isNaN(sky.y[c])) points.push({ x: ((c + 0.5) * cam.width) / cols, y: (sky.y[c] * cam.height) / rows });
  }
  const skyPoints: { x: number; y: number }[] = [];
  for (let c = 0; c < cols; c++) {
    if (sky.blueSky[c]) skyPoints.push({ x: ((c + 0.5) * cam.width) / cols, y: (sky.y[c] * cam.height) / rows });
  }
  const now = performance.now();
  acc.add(skyPoints, cam, msg.offHeading, msg.offPitch, now);
  const reply = (match: MatchResult, source: VisionResponse['source']) =>
    self.postMessage({ id: msg.id, cam, match, source, segMs, panoCoverage: acc.coverage(performance.now()), debug: dbg } satisfies VisionResponse);
  const none: MatchResult = { ok: false, dHeading: 0, dPitch: 0, fovScale: 1, cost: Infinity };
  step(`Spalten ${points.length}/${cols} (Himmel darüber ${skyPoints.length})`);
  if (msg.moving) {
    step(`Schwenk: Rundumprofil gesammelt, Deckung ${acc.coverage(now).toFixed(0)}°/50°`);
    reply(none, 'skyline');
    return;
  }
  const match = matchSkylineHaze(points, [horizon, ...haze], azStep, cam, cols, tols, centers);
  step(`Silhouette ${fmt(match)}${match.ok ? ` Dunst ${match.band}` : ''}`);
  // je Modell-Silhouette: voll, nur Gelände bis 15 km, bis 35 km (zeigt, warum „ambiguous“)
  match.bands.forEach((m, i) => step(`  ${['voll', '15 km', '35 km'][i] ?? i} ${fmt(m)}`));
  if (!match.ok && mask && msg.towerStrip && landmarks.length) {
    // Türme: dünne Spitzen über dem Horizont den bekannten Türmen zuordnen
    const st = msg.towerStrip;
    const band = msg.segBand ?? [0, 1];
    const spikes = detectSpikes(st.pixels, st.w, st.h, cam, [band[0] * cam.height, band[1] * cam.height], mask.prob, mask.size);
    const evals = [horizon, ...haze].map((h) => skylineEvaluator(points, h, azStep, cam));
    const silhouette = (dh: number) => {
      let best = { c: Infinity, dp: 0 };
      for (const ev of evals) {
        for (let dp = -4; dp <= 4; dp += 0.1) {
          const c = ev(dh, dp, 1, 2).c;
          if (c < best.c) best = { c, dp };
        }
      }
      // fein nachführen
      let fine = best;
      for (const ev of evals) {
        for (let dp = best.dp - 0.1; dp <= best.dp + 0.1; dp += 0.02) {
          const c = ev(dh, dp, 1).c;
          if (c < fine.c) fine = { c, dp };
        }
      }
      return fine;
    };
    const silBest = Math.min(...match.bands.map((b) => b.cost));
    const m = matchLandmarks(spikes, landmarks, centers, silhouette, silBest, { heading: cam.heading, half: cam.hfov / 2 });
    step(`Türme ${spikes.length} Spitzen/${landmarks.length} Türme ${fmt(m)}${m.towers?.length ? ` (${m.towers.join(', ')})` : ''}`);
    if (m.ok) return reply(m, 'tower');
  }
  if (!match.ok && msg.stars) {
    // Nachts: Sternmuster
    const st = msg.stars;
    const blobs = detectStars(st.pixels, st.cols, st.rows, cam, horizon, azStep);
    const m = matchStars(blobs, st.refs);
    step(`Sterne ${blobs.length} Flecken/${st.refs.length} Ref. ${fmt(m)}`);
    if (m.ok) return reply(m, 'stars');
  }
  if (!match.ok) {
    // Ohne brauchbare Silhouette: Sonne bzw. Mond als Fixpunkt
    for (const body of msg.bodies) {
      const m = detectBody(pixels, cols, rows, cam, body, horizon, azStep);
      step(`${body.kind === 'sun' ? 'Sonne' : 'Mond'} ${body.az.toFixed(1)}/${body.alt.toFixed(1)}° ${fmt(m)}`);
      if (m.ok) return reply(m, body.kind);
    }
    // Einzelbild zu verdeckt oder zu flach: Rundumprofil aus den letzten Bildern
    const pano = acc.match([horizon, ...haze], azStep, now);
    step(
      `Rundum ${pano.ok ? `✓ H ${pano.heading.toFixed(2)} P ${pano.pitch.toFixed(2)} c ${pano.cost.toFixed(3)}` : `✗ ${pano.reason}${Number.isFinite(pano.cost) ? ` c ${pano.cost.toFixed(3)} (beste H ${pano.heading.toFixed(2)})` : ''}`} · Deckung ${pano.coverage.toFixed(0)}°/50°`,
    );
    if (pano.ok) {
      const m: MatchResult = { ok: true, dHeading: pano.heading - msg.offHeading, dPitch: pano.pitch - msg.offPitch, fovScale: 1, cost: pano.cost };
      return reply(m, 'pano');
    }
    // Sonst wenigstens die Neigung
    // Je Modell-Silhouette (Dunst); widersprechen sich gültige Lösungen, keine Korrektur
    const all = [horizon, ...haze].map((h) => matchPitch(skyPoints, h, azStep, cam, cols));
    step(`Neigung ${all.map(fmt).join(' | ')}`);
    const pitches = all.filter((m) => m.ok);
    const pitch = pitches.sort((a, b) => a.cost - b.cost)[0];
    if (pitch && pitches.every((m) => Math.abs(m.dPitch - pitch.dPitch) < 0.3)) return reply(pitch, 'pitch');
  }
  reply(match, 'skyline');
};
