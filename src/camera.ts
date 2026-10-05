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

  async start(): Promise<void> {
    if (this.active) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia not supported');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
