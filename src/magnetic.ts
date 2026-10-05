/**
 * Magnetische Missweisung nach dem World Magnetic Model 2025 (NOAA/BGS, gemeinfrei),
 * gültig 2025–2030. Handy-Kompasse (Android `deviceorientationabsolute`, iOS
 * `webkitCompassHeading`) zeigen nach magnetisch Nord; geografisch Nord = magnetisch + Missweisung.
 */

const EPOCH = 2025;
const N_MAX = 12;
// Gauß-Koeffizienten (nT, nT/Jahr), Index n(n+1)/2 + m
const G = [0, -29351.8, -1410.8, -2556.6, 2951.1, 1649.3, 1361, -2404.1, 1243.8, 453.6, 895, 799.5, 55.7, -281.1, 12.1, -233.2, 368.9, 187.2, -138.7, -142, 20.9, 64.4, 63.8, 76.9, -115.7, -40.9, 14.9, -60.7, 79.5, -77, -8.8, 59.3, 15.8, 2.5, -11.1, 14.2, 23.2, 10.8, -17.5, 2, -21.7, 16.9, 15, -16.8, 0.9, 4.6, 7.8, 3, -0.2, -2.5, -13.1, 2.4, 8.6, -8.7, -12.9, -1.3, -6.4, 0.2, 2, -1, -0.6, -0.9, 1.5, 0.9, -2.7, -3.9, 2.9, -1.5, -2.5, 2.4, -0.6, -0.1, -0.6, -0.1, 1.1, -1, -0.2, 2.6, -2, -0.2, 0.3, 1.2, -1.3, 0.6, 0.6, 0.5, -0.1, -0.4, -0.2, -1.3, -0.7];
const H = [0, 0, 4545.4, 0, -3133.6, -815.1, 0, -56.6, 237.5, -549.5, 0, 278.6, -133.9, 212, -375.6, 0, 45.4, 220.2, -122.9, 43, 106.1, 0, -18.4, 16.8, 48.8, -59.8, 10.9, 72.7, 0, -48.9, -14.4, -1, 23.4, -7.4, -25.1, -2.3, 0, 7.1, -12.6, 11.4, -9.7, 12.7, 0.7, -5.2, 3.9, 0, -24.8, 12.2, 8.3, -3.3, -5.2, 7.2, -0.6, 0.8, 10, 0, 3.3, 0, 2.4, 5.3, -9.1, 0.4, -4.2, -3.8, 0.9, -9.1, 0, 0, 2.9, -0.6, 0.2, 0.5, -0.3, -1.2, -1.7, -2.9, -1.8, -2.3, 0, -1.3, 0.7, 1, -1.4, 0, 0.6, -0.1, 0.8, 0.1, -1, 0.1, 0.2];
const GD = [0, 12, 9.7, -11.6, -5.2, -8, -1.3, -4.2, 0.4, -15.6, -1.6, -2.4, -6, 5.6, -7, 0.6, 1.4, 0, 0.6, 2.2, 0.9, -0.2, -0.4, 0.9, 1.2, -0.9, 0.3, 0.9, 0, -0.1, -0.1, 0.5, -0.1, -0.8, -0.8, 0.8, -0.1, 0.2, 0, 0.5, -0.1, 0.3, 0.2, 0, 0.2, 0, -0.1, 0.1, 0.3, -0.3, 0, 0.3, -0.1, 0.1, -0.1, 0.1, 0, 0.1, 0.1, 0, -0.3, 0, -0.1, -0.1, 0, 0, 0, 0, 0, 0, 0, -0.1, 0, 0, -0.1, -0.1, -0.1, -0.1, 0, 0, 0, 0, 0, 0, 0.1, 0, 0, 0, -0.1, 0, -0.1];
const HD = [0, 0, -21.5, 0, -27.7, -12.1, 0, 4, -0.3, -4.1, 0, -1.1, 4.1, 1.6, -4.4, 0, -0.5, 2.2, 0.4, 1.7, 1.9, 0, 0.3, -1.6, -0.4, 0.9, 0.7, 0.9, 0, 0.6, 0.5, -0.8, 0, -1, 0.6, -0.2, 0, -0.2, 0.5, -0.4, 0.4, -0.5, -0.6, 0.3, 0.2, 0, -0.3, 0.3, -0.3, 0.3, 0.2, -0.1, -0.2, 0.4, 0.1, 0, 0, 0, -0.2, 0.1, -0.1, 0.1, 0, -0.1, 0.2, 0, 0, 0, 0.1, 0, 0.1, 0, 0, 0.1, 0, 0, 0, 0, 0, 0, 0, -0.1, 0.1, 0, 0, 0, 0, 0, 0, 0, -0.1];

const RAD = Math.PI / 180;
const A = 6378.137; // WGS84 große Halbachse (km)
const E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
const RE = 6371.2; // Referenzradius des Modells (km)

/** Dezimaljahr eines Datums. */
export function decimalYear(date: Date): number {
  const y = date.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  return y + (date.getTime() - start) / (Date.UTC(y + 1, 0, 1) - start);
}

/** Missweisung in Grad (Ost positiv) für geodätische Breite/Länge, Höhe in km über dem Ellipsoid. */
export function declination(lat: number, lon: number, year: number, altKm = 0): number {
  const dt = year - EPOCH;
  // Geodätisch → geozentrisch
  const phi = lat * RAD;
  const sp = Math.sin(phi);
  const rc = A / Math.sqrt(1 - E2 * sp * sp);
  const p = (rc + altKm) * Math.cos(phi);
  const z = (rc * (1 - E2) + altKm) * sp;
  const r = Math.hypot(p, z);
  const phic = Math.asin(z / r);
  const ct = Math.sin(phic); // cos Kolatitude
  const st = Math.max(1e-9, Math.cos(phic));

  // Schmidt-quasinormierte Legendre-Funktionen P und Ableitung nach der Kolatitude
  const P: number[][] = [];
  const dP: number[][] = [];
  for (let n = 0; n <= N_MAX; n++) {
    P.push(new Array(n + 1).fill(0));
    dP.push(new Array(n + 1).fill(0));
  }
  P[0][0] = 1;
  for (let n = 1; n <= N_MAX; n++) {
    for (let m = 0; m <= n; m++) {
      if (m === n) {
        P[n][m] = st * P[n - 1][m - 1];
        dP[n][m] = st * dP[n - 1][m - 1] + ct * P[n - 1][m - 1];
      } else {
        const k = n > 1 ? ((n - 1) ** 2 - m * m) / ((2 * n - 1) * (2 * n - 3)) : 0;
        const p2 = n > 1 && m <= n - 2 ? P[n - 2][m] : 0;
        const dp2 = n > 1 && m <= n - 2 ? dP[n - 2][m] : 0;
        P[n][m] = ct * P[n - 1][m] - k * p2;
        dP[n][m] = ct * dP[n - 1][m] - st * P[n - 1][m] - k * dp2;
      }
    }
  }

  const lam = lon * RAD;
  let north = 0;
  let east = 0;
  let radial = 0;
  let s = 1; // Schmidt-Faktor S(n, 0)
  for (let n = 1; n <= N_MAX; n++) {
    s *= (2 * n - 1) / n;
    let snm = s;
    const ar = (RE / r) ** (n + 2);
    for (let m = 0; m <= n; m++) {
      if (m > 0) snm *= Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m));
      const i = (n * (n + 1)) / 2 + m;
      const g = G[i] + dt * GD[i];
      const h = H[i] + dt * HD[i];
      const cm = Math.cos(m * lam);
      const sm = Math.sin(m * lam);
      const t1 = g * cm + h * sm;
      const t2 = g * sm - h * cm;
      north += ar * t1 * dP[n][m] * snm;
      east += (ar * m * t2 * P[n][m] * snm) / st;
      radial += ar * (n + 1) * t1 * P[n][m] * snm;
    }
  }
  // Nordkomponente in das geodätische System drehen
  const psi = phic - phi;
  const x = north * Math.cos(psi) + radial * Math.sin(psi);
  return Math.atan2(east, x) / RAD;
}
