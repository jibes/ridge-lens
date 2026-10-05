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
  private filtered: ViewAngles | null = null;
  /** iOS: α_abs = α + iosOffset (Einheitsvektor für Kreismittel) */
  private iosOffset: [number, number] | null = null;
  private lastAbsolute = 0;
  private handler = (e: Event) => this.onEvent(e as WebkitOrientationEvent);
  status: OrientationStatus | null = null;

  private smoother = new AngleSmoother();
  private noiseMeter = new NoiseMeter();

  constructor(private onChange: () => void) {}

  /** Hängt die Listener an; Daten kommen auf Android/Desktop ohne weitere Erlaubnis. */
  start(): void {
    window.addEventListener('deviceorientationabsolute', this.handler);
    window.addEventListener('deviceorientation', this.handler);
    void this.requestPermission();
  }

  /** iOS: Erlaubnis anfragen. Ohne Nutzergeste lehnt Safari ab; dann später erneut aus einer Geste. */
  async requestPermission(): Promise<void> {
    const req = (DeviceOrientationEvent as unknown as { requestPermission?: PermissionFn }).requestPermission;
    await req?.call(DeviceOrientationEvent).catch(() => {});
  }

  static get needsPermission(): boolean {
    return typeof (DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission === 'function';
  }

  get angles(): ViewAngles | null {
    return this.filtered;
  }

  /** Streuung der Rohwerte (Standardabweichung, Grad) der letzten 2 s je Achse. */
  get noise(): ViewAngles | null {
    return this.noiseMeter.std();
  }


  private onEvent(e: WebkitOrientationEvent): void {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    let alpha = e.alpha;
    if (e.type === 'deviceorientationabsolute' || e.absolute) {
      // Wechsel von relativ auf absolut: alte Glättung verwerfen
      if (this.status === 'relative') this.smoother.reset();
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
    const raw = viewAngles(v.f, v.r);
    this.noiseMeter.add(raw, e.timeStamp);
    this.filtered = this.smoother.update(raw, e.timeStamp);
    this.onChange();
  }
}

/**
 * One-Euro-Filter (Casiez et al. 2012): Tiefpass, dessen Grenzfrequenz mit der
 * (selbst geglätteten) Änderungsgeschwindigkeit steigt. In Ruhe stark gedämpft,
 * bei echten Bewegungen wenig Verzögerung. Rauschen hebt die Grenzfrequenz kaum,
 * weil die Geschwindigkeit vorher gefiltert wird.
 */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;

  constructor(
    private fcMin: number,
    private beta: number,
    private dCutoff = 1,
  ) {}

  reset(): void {
    this.x = null;
    this.dx = 0;
  }

  filter(value: number, timeMs: number): number {
    if (this.x === null) {
      this.x = value;
      this.t = timeMs;
      return value;
    }
    const dt = Math.min(0.2, Math.max(1e-3, (timeMs - this.t) / 1000));
    this.t = timeMs;
    const a = (fc: number) => 1 - Math.exp(-dt * 2 * Math.PI * fc);
    this.dx += a(this.dCutoff) * ((value - this.x) / dt - this.dx);
    this.x += a(this.fcMin + this.beta * Math.abs(this.dx)) * (value - this.x);
    return this.x;
  }
}

/**
 * Glättung je Achse. Der Kurs (Magnetometer) rauscht am stärksten und wird am
 * trägsten gefiltert; Neigung/Rolle (Beschleunigung + Gyro) sind ruhiger.
 * Grenzfrequenzen in Hz in Ruhe; beta in Hz pro °/s.
 */
export class AngleSmoother {
  // abgestimmt per Simulation: ±2° Rauschen → ±0,2°, Schwenk 60°/s nach 0,4 s eingeholt
  private heading = new OneEuro(0.06, 0.01, 0.3);
  private pitch = new OneEuro(0.15, 0.01, 0.3);
  private roll = new OneEuro(0.1, 0.01, 0.3);
  /** Kurs kontinuierlich (ohne 0°/360°-Sprung) für den Filter */
  private unwrapped: number | null = null;

  reset(): void {
    this.heading.reset();
    this.pitch.reset();
    this.roll.reset();
    this.unwrapped = null;
  }

  update(raw: ViewAngles, timeMs: number): ViewAngles {
    this.unwrapped = this.unwrapped === null ? raw.heading : this.unwrapped + deltaDeg(raw.heading, this.unwrapped);
    return {
      heading: (((this.heading.filter(this.unwrapped, timeMs) % 360) + 360) % 360),
      pitch: this.pitch.filter(raw.pitch, timeMs),
      roll: this.roll.filter(raw.roll, timeMs),
    };
  }
}

/** Rohwert-Streuung der letzten 2 s je Achse (zur Diagnose, welche Achse zittert). */
class NoiseMeter {
  private samples: { t: number; h: number; p: number; r: number }[] = [];
  private unwrapped: number | null = null;

  add(raw: ViewAngles, timeMs: number): void {
    this.unwrapped = this.unwrapped === null ? raw.heading : this.unwrapped + deltaDeg(raw.heading, this.unwrapped);
    this.samples.push({ t: timeMs, h: this.unwrapped, p: raw.pitch, r: raw.roll });
    while (this.samples.length && this.samples[0].t < timeMs - 2000) this.samples.shift();
  }

  std(): ViewAngles | null {
    const n = this.samples.length;
    if (n < 10) return null;
    const sd = (k: 'h' | 'p' | 'r') => {
      const m = this.samples.reduce((acc, x) => acc + x[k], 0) / n;
      return Math.sqrt(this.samples.reduce((acc, x) => acc + (x[k] - m) ** 2, 0) / n);
    };
    return { heading: sd('h'), pitch: sd('p'), roll: sd('r') };
  }
}

function deltaDeg(a: number, b: number): number {
  const d = (((a - b) % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
}
