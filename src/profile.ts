/**
 * Lernendes Sensorprofil: Der Kompass liegt je nach Haltung des Handys unterschiedlich
 * daneben (Hoch-/Querformat, stark geneigt). Jede Korrektur aus dem Bildabgleich wird
 * nach Haltung einsortiert und gleitend gemittelt; ältere Werte verblassen (Halbwertszeit
 * drei Wochen). Ohne aktuellen Bildtreffer gilt der gelernte Wert der aktuellen Haltung.
 */

export interface ProfileEntry {
  /** Gewichtete Summen des Kurses als Einheitsvektor (Kreismittel) und ihr Gewicht. */
  hs: number;
  hc: number;
  hw: number;
  /** Gewichtete Summe der Neigung und ihr Gewicht. */
  ps: number;
  pw: number;
  /** Letzte Aktualisierung (ms). */
  t: number;
}

export interface Learned {
  heading: number | null;
  pitch: number | null;
  /** Wirksame Zahl der Treffer (verblasst). */
  n: number;
}

const RAD = Math.PI / 180;
/** Ab so vielen (gewichteten) Treffern gilt ein Wert als gelernt. */
const MIN_WEIGHT = 3;

/** Haltung aus Bildschirmdrehung: p = Hochformat, l/r = Querformat links/rechts, d = kopfüber. */
export function orientationOf(screenAngle: number): string {
  const a = ((Math.round(screenAngle / 90) * 90) % 360 + 360) % 360;
  return a === 90 ? 'l' : a === 270 ? 'r' : a === 180 ? 'd' : 'p';
}

/** Neigungsstufe (nach unten, waagrecht, nach oben) mit 3° Hysterese gegen Flattern. */
export function pitchBand(pitch: number, prev?: string): string {
  const raw = pitch < -20 ? 'down' : pitch > 20 ? 'up' : 'level';
  if (prev && prev !== raw && Math.min(Math.abs(pitch + 20), Math.abs(pitch - 20)) < 3) return prev;
  return raw;
}

export class SensorProfile {
  constructor(
    private data: Record<string, ProfileEntry> = {},
    private halfLifeMs = 21 * 86_400_000,
  ) {}

  private decay(e: ProfileEntry, now: number): number {
    return Math.pow(0.5, Math.max(0, now - e.t) / this.halfLifeMs);
  }

  /** Neue Korrektur (Grad) für eine Haltung; null = für diese Größe keine Aussage. */
  update(key: string, heading: number | null, pitch: number | null, weight: number, now: number): void {
    const e = this.data[key] ?? { hs: 0, hc: 0, hw: 0, ps: 0, pw: 0, t: now };
    const k = this.decay(e, now);
    e.hs *= k;
    e.hc *= k;
    e.hw *= k;
    e.ps *= k;
    e.pw *= k;
    if (heading !== null) {
      e.hs += weight * Math.sin(heading * RAD);
      e.hc += weight * Math.cos(heading * RAD);
      e.hw += weight;
    }
    if (pitch !== null) {
      e.ps += weight * pitch;
      e.pw += weight;
    }
    e.t = now;
    this.data[key] = e;
  }

  /** Gelernter Wert; null, solange zu wenige Treffer vorliegen. */
  get(key: string, now: number): Learned | null {
    const e = this.data[key];
    if (!e) return null;
    const k = this.decay(e, now);
    const hw = e.hw * k;
    const pw = e.pw * k;
    if (hw < MIN_WEIGHT && pw < MIN_WEIGHT) return null;
    return {
      heading: hw >= MIN_WEIGHT ? Math.atan2(e.hs, e.hc) / RAD : null,
      pitch: pw >= MIN_WEIGHT ? e.ps / e.pw : null,
      n: Math.max(hw, pw),
    };
  }

  /** Alle gelernten Haltungen (für die Anzeige). */
  entries(now: number): (Learned & { key: string })[] {
    return Object.keys(this.data)
      .map((key) => ({ key, ...this.get(key, now) }))
      .filter((e): e is Learned & { key: string } => e.n !== undefined);
  }

  clear(): void {
    this.data = {};
  }

  toJSON(): Record<string, ProfileEntry> {
    return this.data;
  }
}
