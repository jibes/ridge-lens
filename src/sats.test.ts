import { describe, expect, it } from 'vitest';
import { nextPass, parseSats, satLook } from './sats';

// ISS, Bahnelemente mit Epoche 6.10.2026 (für den Test hinreichend)
const ISS = {
  n: 'ISS (ZARYA)',
  l1: '1 25544U 98067A   26279.50000000  .00016717  00000-0  10270-3 0  9005',
  l2: '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50377579 99999',
};
const zurich = { lat: 47.37, lon: 8.54, h: 450 };

describe('satellites', () => {
  const [iss] = parseSats({ sats: [ISS] });

  it('names major stations', () => {
    expect(iss.name).toBe('ISS');
    expect(iss.major).toBe(true);
    expect(iss.key).toBe('sat:25544');
  });

  it('is in the Earth shadow for roughly a third of each orbit', () => {
    let lit = 0;
    const t0 = Date.UTC(2026, 9, 6, 12);
    for (let m = 0; m < 1440; m++) if (satLook(iss, new Date(t0 + m * 60_000), zurich.lat, zurich.lon, zurich.h)!.sunlit) lit++;
    expect(lit / 1440).toBeGreaterThan(0.55);
    expect(lit / 1440).toBeLessThan(0.8);
  });

  it('finds the next pass over Zürich', () => {
    const from = Date.UTC(2026, 9, 6, 12);
    const p = nextPass(iss, from, zurich.lat, zurich.lon, zurich.h)!;
    expect(p).not.toBeNull();
    expect(p.rise).toBeGreaterThanOrEqual(from);
    expect(p.set - p.rise).toBeLessThan(15 * 60_000);
    expect(p.maxAlt).toBeGreaterThan(0);
    expect(p.path.every((q) => q.alt > 0)).toBe(true);
    // Der nächste Überflug beginnt danach
    const q = nextPass(iss, p.set + 60_000, zurich.lat, zurich.lon, zurich.h)!;
    expect(q.rise).toBeGreaterThan(p.set);
  });
});
