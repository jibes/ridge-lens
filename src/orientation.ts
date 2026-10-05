/**
 * Geräteorientierung → Blickrichtung der Rückkamera.
 *
 * W3C-Konvention: Erdsystem x = Ost, y = Nord, z = oben; Gerätesystem x = rechts,
 * y = oben (Hochformat), z = aus dem Display heraus. Rotation R = Rz(α)·Rx(β)·Ry(γ).
 * Die Rückkamera blickt entlang −z des Geräts.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

type Vec3 = [number, number, number];

export interface ViewAngles {
  heading: number;
  pitch: number;
  roll: number;
}

/** Rotationsmatrix (zeilenweise) aus Euler-Winkeln in Grad. */
export function rotationMatrix(alpha: number, beta: number, gamma: number): number[] {
  const cA = Math.cos(alpha * RAD), sA = Math.sin(alpha * RAD);
  const cB = Math.cos(beta * RAD), sB = Math.sin(beta * RAD);
  const cG = Math.cos(gamma * RAD), sG = Math.sin(gamma * RAD);
  return [
    cA * cG - sA * sB * sG, -cB * sA, cA * sG + cG * sA * sB,
    cG * sA + cA * sB * sG, cA * cB, sA * sG - cA * cG * sB,
    -cB * sG, sB, cB * cG,
  ];
}

function apply(m: number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * Blickachse und rechte Bildkante im Erdsystem.
 * `screenAngle` = screen.orientation.angle (0 Hochformat, 90 Querformat gegen Uhrzeiger gedreht).
 */
export function deviceVectors(alpha: number, beta: number, gamma: number, screenAngle: number): { f: Vec3; r: Vec3 } {
  const m = rotationMatrix(alpha, beta, gamma);
  const t = screenAngle * RAD;
  return {
    f: apply(m, [0, 0, -1]),
    // rechte Bildschirmkante im Gerätesystem, abhängig von der Bildschirmdrehung
    r: apply(m, [Math.cos(t), -Math.sin(t), 0]),
  };
}

/** Blickrichtung, Neigung, Rolle aus Blickachse f und rechter Bildkante r (ENU). */
export function viewAngles(f: Vec3, r: Vec3): ViewAngles {
  const heading = ((Math.atan2(f[0], f[1]) * DEG) + 360) % 360;
  const pitch = Math.asin(Math.max(-1, Math.min(1, f[2]))) * DEG;
  // waagrechte Referenz: r0 = f × oben, u0 = r0 × f
  const r0: Vec3 = [f[1], -f[0], 0];
  const n = Math.hypot(r0[0], r0[1]) || 1;
  r0[0] /= n;
  r0[1] /= n;
  const u0: Vec3 = [r0[1] * f[2], -r0[0] * f[2], r0[0] * f[1] - r0[1] * f[0]];
  const roll = Math.atan2(r[0] * u0[0] + r[1] * u0[1] + r[2] * u0[2], r[0] * r0[0] + r[1] * r0[1]) * DEG;
  return { heading, pitch, roll };
}

interface WebkitOrientationEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

type PermissionFn = () => Promise<'granted' | 'denied'>;

export type OrientationStatus = 'absolute' | 'relative';

/**
 * Liefert geglättete Blickwinkel. Android: `deviceorientationabsolute` (Nord-bezogen).
 * iOS: α ist relativ; Nordbezug über `webkitCompassHeading` als gleitende Konstante.
 */
export class OrientationTracker {
  private f: Vec3 | null = null;
  private r: Vec3 | null = null;
  /** iOS: α_abs = α + iosOffset (Einheitsvektor für Kreismittel) */
  private iosOffset: [number, number] | null = null;
  private lastAbsolute = 0;
  private handler = (e: Event) => this.onEvent(e as WebkitOrientationEvent);
  status: OrientationStatus | null = null;

  constructor(private onChange: () => void, private smoothing = 0.25) {}

  /** Muss aus einem Klick-Handler aufgerufen werden (iOS-Berechtigung). */
  async start(): Promise<void> {
    const req = (DeviceOrientationEvent as unknown as { requestPermission?: PermissionFn }).requestPermission;
    if (req && (await req()) !== 'granted') throw new Error('Zugriff auf Bewegungssensoren verweigert');
    window.addEventListener('deviceorientationabsolute', this.handler);
    window.addEventListener('deviceorientation', this.handler);
  }

  stop(): void {
    window.removeEventListener('deviceorientationabsolute', this.handler);
    window.removeEventListener('deviceorientation', this.handler);
    this.f = this.r = null;
    this.status = null;
  }

  get angles(): ViewAngles | null {
    return this.f && this.r ? viewAngles(this.f, this.r) : null;
  }

  private onEvent(e: WebkitOrientationEvent): void {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    let alpha = e.alpha;
    if (e.type === 'deviceorientationabsolute' || e.absolute) {
      // Wechsel von relativ auf absolut: alte Glättung verwerfen
      if (this.status === 'relative') this.f = this.r = null;
      this.lastAbsolute = e.timeStamp;
      this.status = 'absolute';
    } else {
      // Relatives Event ignorieren, solange absolute geliefert werden
      if (e.timeStamp - this.lastAbsolute < 1000) return;
      if (typeof e.webkitCompassHeading === 'number' && (e.webkitCompassAccuracy ?? 0) >= 0) {
        // heading = −α_abs  ⇒  Offset = −heading − α
        const off = (-e.webkitCompassHeading - alpha) * RAD;
        const k = this.iosOffset ? 0.05 : 1;
        const prev = this.iosOffset ?? [0, 0];
        this.iosOffset = [prev[0] + (Math.cos(off) - prev[0]) * k, prev[1] + (Math.sin(off) - prev[1]) * k];
      }
      if (this.iosOffset) {
        alpha += Math.atan2(this.iosOffset[1], this.iosOffset[0]) * DEG;
        this.status = 'absolute';
      } else {
        this.status = 'relative';
      }
    }
    const angle = screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0;
    const v = deviceVectors(alpha, e.beta, e.gamma, angle);
    this.f = blend(this.f, v.f, this.smoothing);
    this.r = blend(this.r, v.r, this.smoothing);
    this.onChange();
  }
}

/** Exponentielle Glättung auf Einheitsvektoren (kein Problem mit 0/360-Sprung). */
function blend(prev: Vec3 | null, next: Vec3, k: number): Vec3 {
  if (!prev) return next;
  const v: Vec3 = [prev[0] + (next[0] - prev[0]) * k, prev[1] + (next[1] - prev[1]) * k, prev[2] + (next[2] - prev[2]) * k];
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}
