import { deltaDeg } from './geo';

const RAD = Math.PI / 180;

export interface Camera {
  /** Blickrichtung (Grad, 0 = Nord). */
  heading: number;
  /** Neigung der Blickachse (Grad, + = nach oben). */
  pitch: number;
  /** Horizontales Sichtfeld (Grad). */
  hfov: number;
  width: number;
  height: number;
}

/**
 * Lochkamera-Projektion von (Azimut, Höhenwinkel) auf Bildschirmpixel.
 * Gleiches Modell wie später für das Kamerabild. Null hinter der Kamera.
 */
export function project(cam: Camera, az: number, el: number): [number, number] | null {
  const f = cam.width / 2 / Math.tan((cam.hfov / 2) * RAD);
  const da = deltaDeg(az, cam.heading) * RAD;
  const e = el * RAD;
  const p = cam.pitch * RAD;
  const x = Math.cos(e) * Math.sin(da);
  const y = Math.sin(e);
  const z = Math.cos(e) * Math.cos(da);
  const yc = y * Math.cos(p) - z * Math.sin(p);
  const zc = y * Math.sin(p) + z * Math.cos(p);
  if (zc < 0.05) return null;
  return [cam.width / 2 + (f * x) / zc, cam.height / 2 - (f * yc) / zc];
}

/** Umkehrung für horizontale Bildschirmposition auf der Bildmitte: Pixel → Azimut. */
export function degreesPerPixel(cam: Camera): number {
  return cam.hfov / cam.width;
}
