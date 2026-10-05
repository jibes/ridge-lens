// Lädt benannte Gipfel (OSM natural=peak) für die Alpen und Umgebung über Overpass
// und schreibt sie als 1°-Kacheln nach public/peaks/. Läuft im CI vor dem Build.
// Format je Kachel: [[id, lat, lon, ele|null, name, de, en, fr, it], …] (leere Namen = "").
import { mkdir, writeFile } from 'node:fs/promises';

const REGION = { south: 42, north: 50, west: 2, east: 18 };
const BLOCK = 2; // Grad je Overpass-Abfrage
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const LANGS = ['de', 'en', 'fr', 'it'];
const OUT = new URL('../public/peaks/', import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseEle(raw) {
  if (!raw) return null;
  const m = raw.replace(/['’\s]/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let v = parseFloat(m[0]);
  if (/ft|feet/.test(raw)) v *= 0.3048;
  return Number.isFinite(v) && v > -500 && v < 9000 ? Math.round(v) : null;
}

async function query(s, w, n, e) {
  const fields = ['::id', '::lat', '::lon', 'ele', 'name', ...LANGS.map((l) => `"name:${l}"`)].join(',');
  const q = `[out:csv(${fields};false;"\\t")][timeout:180][bbox:${s},${w},${n},${e}];node["natural"="peak"]["name"];out qt;`;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const ep of ENDPOINTS) {
      try {
        const res = await fetch(ep, {
          method: 'POST',
          body: new URLSearchParams({ data: q }),
          headers: { 'User-Agent': 'ridge-lens-build (github.com/jibes/ridge-lens)' },
          signal: AbortSignal.timeout(200_000),
        });
        const text = await res.text();
        if (!res.ok || /<html|runtime error/i.test(text.slice(0, 500))) throw new Error(`HTTP ${res.status}`);
        return text;
      } catch (err) {
        console.warn(`  ${new URL(ep).hostname}: ${err.message}`);
      }
    }
    await sleep(10_000 * (attempt + 1));
  }
  throw new Error(`block ${s},${w} failed on all servers`);
}

const tiles = new Map();
let total = 0;
for (let s = REGION.south; s < REGION.north; s += BLOCK) {
  for (let w = REGION.west; w < REGION.east; w += BLOCK) {
    const text = await query(s, w, s + BLOCK, w + BLOCK);
    let count = 0;
    for (const line of text.split('\n')) {
      const [id, lat, lon, ele, name, ...names] = line.split('\t');
      if (!name || !lat || !lon) continue;
      const la = Number(lat);
      const lo = Number(lon);
      const key = `${Math.floor(la)}_${Math.floor(lo)}`;
      // Gipfel auf Blockgrenzen kommen doppelt; nach OSM-ID entdoppeln
      if (!tiles.has(key)) tiles.set(key, new Map());
      tiles.get(key).set(id, [Number(id), +la.toFixed(5), +lo.toFixed(5), parseEle(ele), name, ...LANGS.map((_, i) => names[i] ?? '')]);
      count++;
    }
    total += count;
    console.log(`block ${s},${w}: ${count} peaks`);
    await sleep(2_000); // Overpass schonen
  }
}

await mkdir(OUT, { recursive: true });
for (const [key, rows] of tiles) await writeFile(new URL(`${key}.json`, OUT), JSON.stringify([...rows.values()]));
await writeFile(
  new URL('index.json', OUT),
  JSON.stringify({ generated: new Date().toISOString(), region: REGION, tiles: [...tiles.keys()].sort() }),
);
console.log(`${total} peaks in ${tiles.size} tiles`);
if (total < 1000) throw new Error('implausibly few peaks');
