import { deltaDeg } from './geo';

const RAD = Math.PI / 180;

export interface Camera {
  /** Blickrichtung (Grad, 0 = Nord). */
  heading: number;
  /** Neigung der Blickachse (Grad, + = nach oben). */
  pitch: number;
  /** Drehung um die Blickachse (Grad, + = rechte Bildkante nach oben). */
  roll: number;
  /** Horizontales Sichtfeld (Grad). */
  hfov: number;
  width: number;
  height: number;
}

type Vec3 = [number, number, number];

/** Kamerabasis in ENU (x = Ost, y = Nord, z = oben): vorwärts, rechts, oben. */
export function cameraBasis(cam: Pick<Camera, 'heading' | 'pitch' | 'roll'>): { f: Vec3; r: Vec3; u: Vec3 } {
  const h = cam.heading * RAD;
  const p = cam.pitch * RAD;
  const q = cam.roll * RAD;
  const f: Vec3 = [Math.cos(p) * Math.sin(h), Math.cos(p) * Math.cos(h), Math.sin(p)];
  const r0: Vec3 = [Math.cos(h), -Math.sin(h), 0];
  const u0: Vec3 = [-Math.sin(p) * Math.sin(h), -Math.sin(p) * Math.cos(h), Math.cos(p)];
  const c = Math.cos(q);
  const s = Math.sin(q);
  return {
    f,
    r: [r0[0] * c + u0[0] * s, r0[1] * c + u0[1] * s, r0[2] * c + u0[2] * s],
    u: [u0[0] * c - r0[0] * s, u0[1] * c - r0[1] * s, u0[2] * c - r0[2] * s],
  };
}

/**
 * Lochkamera-Projektion von (Azimut, Höhenwinkel) auf Bildschirmpixel.
 * Gleiches Modell wie später für das Kamerabild. Null hinter der Kamera.
 */
export function project(cam: Camera, az: number, el: number): [number, number] | null {
  const { f, r, u } = cameraBasis(cam);
  return projectWith(cam, f, r, u, az, el);
}

/** Wie `project`, aber mit vorberechneter Basis (für viele Punkte pro Frame). */
export function projector(cam: Camera): (az: number, el: number) => [number, number] | null {
  const { f, r, u } = cameraBasis(cam);
  return (az, el) => projectWith(cam, f, r, u, az, el);
}

function projectWith(cam: Camera, f: Vec3, r: Vec3, u: Vec3, az: number, el: number): [number, number] | null {
  const a = az * RAD;
  const e = el * RAD;
  const d: Vec3 = [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
  const zc = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
  if (zc < 0.05) return null;
  const F = cam.width / 2 / Math.tan((cam.hfov / 2) * RAD);
  const xc = d[0] * r[0] + d[1] * r[1] + d[2] * r[2];
  const yc = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
  return [cam.width / 2 + (F * xc) / zc, cam.height / 2 - (F * yc) / zc];
}

/** Halbe Bilddiagonale in Grad: alles außerhalb dieses Winkels zur Blickachse ist unsichtbar. */
export function halfDiagonalFov(cam: Camera): number {
  const tx = Math.tan((cam.hfov / 2) * RAD);
  const ty = (tx * cam.height) / cam.width;
  return Math.atan(Math.hypot(tx, ty)) / RAD;
}

/** Ob Azimut grob im Bild liegen kann (für Vorfilterung, berücksichtigt Rolle grob). */
export function azimuthInView(cam: Camera, az: number, margin = 2): boolean {
  const limit = Math.min(89, (cam.roll === 0 ? cam.hfov / 2 : halfDiagonalFov(cam)) + margin + Math.abs(cam.pitch) * 0.5);
  return Math.abs(deltaDeg(az, cam.heading)) <= limit;
}
