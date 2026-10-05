/** Gipfelsuche: Name oder Übersetzung, ohne Groß-/Kleinschreibung und Akzente. */

interface Searchable {
  id: number;
  name: string;
  names: Partial<Record<string, string>>;
  ele: number;
  fame: number;
  visible: boolean;
}

export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** 3 = ganzer Name, 2 = Anfang, 1.5 = Wortanfang, 1 = irgendwo, 0 = kein Treffer. */
function matchScore(name: string, q: string): number {
  const n = fold(name);
  if (n === q) return 3;
  if (n.startsWith(q)) return 2;
  if (n.split(/[\s\-'’/]+/).some((w) => w.startsWith(q))) return 1.5;
  return n.includes(q) ? 1 : 0;
}

/** Beste Treffer: Übereinstimmung, dann Bekanntheit, sichtbar vor verdeckt, Höhe. */
export function searchPeaks<P extends Searchable>(peaks: readonly P[], query: string, limit = 8): P[] {
  const q = fold(query.trim());
  if (!q) return [];
  const hits: { p: P; s: number }[] = [];
  const seen = new Set<number>();
  for (const p of peaks) {
    if (seen.has(p.id)) continue;
    let s = matchScore(p.name, q);
    for (const n of Object.values(p.names)) if (n) s = Math.max(s, matchScore(n, q));
    if (s > 0) {
      seen.add(p.id);
      hits.push({ p, s });
    }
  }
  hits.sort((a, b) => b.s - a.s || b.p.fame - a.p.fame || Number(b.p.visible) - Number(a.p.visible) || b.p.ele - a.p.ele);
  return hits.slice(0, limit).map((h) => h.p);
}
