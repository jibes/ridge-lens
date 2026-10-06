import { describe, expect, it } from 'vitest';
import { dayTrack } from './tracks';
import type { SkyData } from './nightsky';

const data: SkyData = {
  stars: [[101.287, -16.716, -1.46, 0, { en: 'Sirius', de: 'Sirius', fr: 'Sirius', it: 'Sirio' }]],
  constellations: [],
};
const start = Date.UTC(2026, 0, 15);
const maxAlt = (key: string) => Math.max(...dayTrack(key, data, 47.37, 8.54, start, start + 86_400_000, 5).map((p) => p.alt));

describe('dayTrack', () => {
  it('culminates at 90° − latitude + declination', () => {
    expect(maxAlt('star:Sirius')).toBeCloseTo(90 - 47.37 - 16.72, 0);
    expect(maxAlt('mw')).toBeCloseTo(90 - 47.37 - 29.01, 0);
  });

  it('planets move, unknown keys give no track', () => {
    expect(dayTrack('planet:jupiter', data, 47.37, 8.54, start, start + 86_400_000, 10)).toHaveLength(145);
    expect(dayTrack('star:Nope', data, 47.37, 8.54, start, start + 3_600_000)).toEqual([]);
  });
});
