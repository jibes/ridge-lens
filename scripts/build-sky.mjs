// Erzeugt public/sky/sky.json aus den Daten des npm-Pakets d3-celestial (BSD-3, Olaf Frohn;
// Sterne nach XHIP, Sternbilder nach IAU). Aufruf: node scripts/build-sky.mjs <pfad/zu/d3-celestial/data>
//
// sky.json: {
//   stars: [[ra, dec, mag, bv, names?], …]   J2000, Grad; names = {en, de, fr, it} nur für helle benannte Sterne
//   constellations: [{ id, names: {la, en, de, fr, it}, label: [ra, dec], lines: [[[ra, dec], …], …] }, …]
// }
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const MAG_LIMIT = 5.5;
const NAME_MAG = 2.5;
const dir = process.argv[2];
if (!dir) throw new Error('Pfad zu d3-celestial/data angeben');
const read = async (f) => JSON.parse(await readFile(`${dir}/${f}`, 'utf8'));

const ra = (lon) => +(((lon % 360) + 360) % 360).toFixed(3);
const stars = await read('stars.6.json');
const names = await read('starnames.json');
const out = { stars: [], constellations: [] };
for (const f of stars.features) {
  const mag = Number(f.properties.mag);
  if (!(mag <= MAG_LIMIT)) continue;
  const [lon, lat] = f.geometry.coordinates;
  const row = [ra(lon), +lat.toFixed(3), +mag.toFixed(1), +(Number(f.properties.bv) || 0).toFixed(1)];
  const n = names[f.id];
  if (n?.name && mag <= NAME_MAG) row.push({ en: n.name, de: n.de || n.name, fr: n.fr || n.name, it: n.it || n.name });
  out.stars.push(row);
}
out.stars.sort((a, b) => a[2] - b[2]);

const cons = await read('constellations.json');
const lines = await read('constellations.lines.json');
const lineById = new Map(lines.features.map((f) => [f.id, f.geometry.coordinates]));
for (const f of cons.features) {
  const p = f.properties;
  const [lon, lat] = p.display ?? f.geometry.coordinates;
  out.constellations.push({
    id: f.id,
    names: { la: p.name, en: p.en || p.name, de: p.de || p.name, fr: p.fr || p.name, it: p.it || p.name },
    label: [ra(lon), +lat.toFixed(2)],
    lines: (lineById.get(f.id) ?? []).map((l) => l.map(([x, y]) => [ra(x), +y.toFixed(3)])),
  });
}

const target = new URL('../public/sky/', import.meta.url);
await mkdir(target, { recursive: true });
await writeFile(new URL('sky.json', target), JSON.stringify(out));
console.log(`${out.stars.length} Sterne, ${out.stars.filter((s) => s[4]).length} mit Namen, ${out.constellations.length} Sternbilder`);
