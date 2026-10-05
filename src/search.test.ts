import { describe, expect, it } from 'vitest';
import { fold, searchPeaks } from './search';

const peak = (id: number, name: string, ele: number, extra: Partial<{ names: Record<string, string>; fame: number; visible: boolean }> = {}) => ({
  id, name, ele, names: extra.names ?? {}, fame: extra.fame ?? 0, visible: extra.visible ?? true,
});

const peaks = [
  peak(1, 'Matterhorn', 4478, { names: { fr: 'Cervin', it: 'Cervino' }, fame: 80 }),
  peak(2, 'Kleines Matterhorn', 3883, { fame: 10 }),
  peak(3, 'Mönch', 4107, { fame: 40 }),
  peak(4, 'Piz Mönchalp', 2900),
  peak(5, 'Grosser Mythen', 1898, { fame: 20 }),
];

describe('searchPeaks', () => {
  it('folds accents and case', () => {
    expect(fold('Mönch')).toBe('monch');
    expect(searchPeaks(peaks, 'MONCH').map((p) => p.id)).toEqual([3, 4]);
  });

  it('ranks full and prefix matches before word and substring matches', () => {
    expect(searchPeaks(peaks, 'matterhorn').map((p) => p.id)).toEqual([1, 2]);
    expect(searchPeaks(peaks, 'myth').map((p) => p.id)).toEqual([5]);
  });

  it('finds translated names', () => {
    expect(searchPeaks(peaks, 'cerv').map((p) => p.id)).toEqual([1]);
  });

  it('empty query → nothing', () => {
    expect(searchPeaks(peaks, '  ')).toEqual([]);
  });
});
