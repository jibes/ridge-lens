import { describe, expect, it } from 'vitest';
import { compassLabels, detectLang, KEYS, LANGS, setLang, t } from './i18n';

describe('i18n', () => {
  it('detects first supported system language, falls back to English', () => {
    expect(detectLang(['fr-CH', 'de'])).toBe('fr');
    expect(detectLang(['es-ES', 'it-IT'])).toBe('it');
    expect(detectLang(['ja'])).toBe('en');
    expect(detectLang([])).toBe('en');
  });

  it('all languages use the same placeholders per key', () => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join();
    for (const key of KEYS) {
      const ref = placeholders(t(key, {}, 'de'));
      for (const l of LANGS) expect(placeholders(t(key, {}, l)), `${l}:${key}`).toBe(ref);
    }
    for (const l of LANGS) {
      setLang(l);
      expect(compassLabels(8)).toHaveLength(8);
      expect(compassLabels(16)).toHaveLength(16);
    }
  });

  it('interpolates params and localizes compass', () => {
    setLang('fr');
    expect(t('status.result', { ele: 1799, count: 9 })).toBe('1799 m d’alt. · 9 sommets visibles');
    expect(compassLabels(8)[6]).toBe('O');
    setLang('en');
    expect(compassLabels(16)[1]).toBe('NNE');
  });
});
