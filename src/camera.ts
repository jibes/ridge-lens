const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * Bildwinkel der Hauptkamera entlang der langen Bildseite. Typische Handy-Hauptkamera:
 * 26 mm Kleinbild-äquivalent, 4:3-Sensor → ca. 67°. 16:9-Videos schneiden die kurze
 * Seite ab, die lange bleibt.
 */
export const DEFAULT_CAMERA_FOV = 67;

/**
 * Horizontales Sichtfeld der Anzeige, wenn das Video mit `object-fit: cover` die
 * Fläche W×H füllt (zentriert beschnitten).
 */
export function displayHfov(fovLong: number, videoW: number, videoH: number, W: number, H: number): number {
  const focalVideo = Math.max(videoW, videoH) / 2 / Math.tan((fovLong / 2) * RAD);
  const scale = Math.max(W / videoW, H / videoH);
  return 2 * Math.atan(W / 2 / (focalVideo * scale)) * DEG;
}

/** Umkehrung: aus gewünschtem Anzeige-Sichtfeld den Bildwinkel der langen Seite. */
export function fovLongFromDisplay(hfov: number, videoW: number, videoH: number, W: number, H: number): number {
  const scale = Math.max(W / videoW, H / videoH);
  const focalDisplay = W / 2 / Math.tan((hfov / 2) * RAD);
  return 2 * Math.atan(Math.max(videoW, videoH) / 2 / (focalDisplay / scale)) * DEG;
}

export interface CameraInfo {
  id: string;
  label: string;
}

/**
 * Hauptkamera unter den Rückkameras: Ultraweitwinkel/Tele meiden (Chrome wählt mit
 * facingMode sonst oft die 0,5×-Kamera, z. B. bei Samsung), bei Android-Namen
 * „camera2 N, facing back“ die kleinste Nummer.
 */
export function pickMainCamera(cams: CameraInfo[]): CameraInfo | null {
  const back = cams.filter((c) => /back|rear|environment|rück/i.test(c.label));
  if (!back.length) return null;
  const plain = back.filter((c) => !/ultra|wide|tele|0[.,]5|macro|depth/i.test(c.label));
  const pool = plain.length ? plain : back;
  const num = (c: CameraInfo) => Number(/camera2?\s*(\d+)/i.exec(c.label)?.[1] ?? 99);
  return [...pool].sort((a, b) => num(a) - num(b))[0];
}

/** Rückkamera als Video-Hintergrund. */
export class CameraFeed {
  private stream: MediaStream | null = null;

  constructor(private video: HTMLVideoElement) {}

  get active(): boolean {
    return !!this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  /** Größe des Videobilds in Pixeln (0, solange noch kein Bild da ist). */
  get size(): { w: number; h: number } {
    return { w: this.video.videoWidth, h: this.video.videoHeight };
  }

  /** Id der laufenden Kamera. */
  get deviceId(): string | undefined {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId;
  }

  /** Rückkameras mit Namen (erst nach erteilter Kamera-Erlaubnis verfügbar). */
  async backCameras(): Promise<CameraInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    return devices.filter((d) => d.kind === 'videoinput' && !/front|user|selfie/i.test(d.label)).map((d) => ({ id: d.deviceId, label: d.label }));
  }

  private async open(video: MediaTrackConstraints): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1920 }, height: { ideal: 1080 }, ...video } });
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
  }

  /** Startet die gewählte Kamera, sonst die Hauptkamera (siehe pickMainCamera). */
  async start(preferredId?: string): Promise<void> {
    if (this.active) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia not supported');
    if (preferredId) {
      try {
        await this.open({ deviceId: { exact: preferredId } });
      } catch {
        await this.open({ facingMode: { ideal: 'environment' } });
      }
    } else {
      await this.open({ facingMode: { ideal: 'environment' } });
      // Erst mit Erlaubnis gibt es Kameranamen: ggf. auf die Hauptkamera wechseln
      const main = pickMainCamera(await this.backCameras());
      if (main && main.id !== this.deviceId) {
        this.stop();
        await this.open({ deviceId: { exact: main.id } }).catch(() => this.open({ facingMode: { ideal: 'environment' } }));
      }
    }
    await this.zoomToOne();
  }

  /** Kombinierte Kameras mit Zoombereich ab 0,5×: auf 1× (Hauptkamera) stellen. */
  private async zoomToOne(): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];
    const caps = track?.getCapabilities?.() as (MediaTrackCapabilities & { zoom?: { min: number; max: number } }) | undefined;
    if (track && caps?.zoom && caps.zoom.min < 1 && caps.zoom.max >= 1) {
      await track.applyConstraints({ advanced: [{ zoom: 1 } as MediaTrackConstraintSet] }).catch(() => {});
    }
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}

/** Messpunkt der Neigungs-Kalibrierung: Lage des Horizonts über der Bildmitte und nötige Neigungskorrektur. */
export interface TiltSample {
  /** Winkel des erkannten Horizonts über der Bildmitte (Grad, mit dem angenommenen Bildwinkel). */
  axis: number;
  /** Gesamte Neigungskorrektur gegenüber dem Sensor, die dieses Bild verlangt (Grad). */
  pitch: number;
}

/**
 * Bildwinkel aus mehreren Bildern bei verschiedener Neigung: Ist er falsch, wächst die
 * nötige Neigungskorrektur mit dem Abstand des Horizonts zur Bildmitte (r = c0 + k·a,
 * k = F_angenommen/F_wahr − 1). Ausgleichsgerade über die Messpunkte; null, solange die
 * Punkte nicht weit genug streuen oder nicht auf einer Geraden liegen.
 */
export function fitTilt(samples: TiltSample[]): { scale: number; pitch: number } | null {
  const n = samples.length;
  if (n < 8) return null;
  const xs = samples.map((s) => s.axis);
  if (Math.max(...xs) - Math.min(...xs) < 8) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = samples.reduce((a, s) => a + s.pitch, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const s of samples) {
    sxy += (s.axis - mx) * (s.pitch - my);
    sxx += (s.axis - mx) ** 2;
  }
  const k = sxy / sxx;
  const c0 = my - k * mx;
  const res = Math.sqrt(samples.reduce((a, s) => a + (s.pitch - c0 - k * s.axis) ** 2, 0) / n);
  if (res > 0.25 || Math.abs(k) > 0.3) return null;
  // tan(fov/2) skaliert mit 1/F: F_wahr = F_angenommen/(1+k)
  return { scale: 1 + k, pitch: c0 };
}
