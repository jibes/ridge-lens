// Bahnelemente der Satelliten für die App: TLE-Dateien (CelesTrak) → public/peaks/sats.json
// { generated, sats: [{ n, l1, l2 }] }, je Katalognummer einmal. Aufruf mit den TLE-Dateien
// als Argumenten; zu wenige gültige Einträge → Abbruch, die bisherige Datei bleibt.
import { readFile, writeFile } from 'node:fs/promises';

const OUT = new URL('../public/peaks/sats.json', import.meta.url);
const sats = new Map();
for (const file of process.argv.slice(2)) {
  const lines = (await readFile(file, 'utf8').catch(() => '')).split(/\r?\n/).map((l) => l.trimEnd());
  for (let i = 0; i + 2 < lines.length + 1; i++) {
    const [n, l1, l2] = [lines[i], lines[i + 1], lines[i + 2]];
    if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ') || !n) continue;
    const id = l1.slice(2, 7).trim();
    if (!sats.has(id)) sats.set(id, { n: n.trim(), l1, l2 });
    i += 2;
  }
}
if (sats.size < 50) throw new Error(`nur ${sats.size} Satelliten – sats.json bleibt unverändert`);
await writeFile(OUT, JSON.stringify({ generated: new Date().toISOString(), sats: [...sats.values()] }));
console.log(`Satelliten: ${sats.size}`);
