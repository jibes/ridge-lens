// Lädt benannte Gipfel (OSM natural=peak) für die Alpen und Umgebung über Overpass
// und schreibt sie als 1°-Kacheln nach public/peaks/. Läuft im CI vor dem Build.
//
// Overpass ist oft überlastet (429/504). Deshalb inkrementell: Abfrage in 2°-Blöcken,
// nach jedem Block wird gespeichert; ein Zeitbudget beendet den Lauf rechtzeitig, damit
// der CI-Cache den Stand sichert. Folgeläufe holen fehlende und veraltete Blöcke nach,
// beginnend in der Mitte der Alpen.
//
// Kachel:   [[id, lat, lon, ele|null, name, de, en, fr, it], …] (leere Namen = "")
// index.json: { generated, region, blockSize, blocks: ["46_8", …], tiles: ["46_8", …] }
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

const REGION = { south: 42, north: 50, west: 2, east: 18 };
const BLOCK = 2;
const CENTER = { lat: 46.75, lon: 8.25 };
const MAX_AGE_DAYS = 30;
const BUDGET_MS = Number(process.env.PEAKS_BUDGET_MIN ?? 20) * 60_000;
const PAUSE_MS = Number(process.env.PEAKS_PAUSE_MS ?? 2_000);
const ENDPOINTS = process.env.OVERPASS_ENDPOINTS?.split(',') ?? [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const LANGS = ['de', 'en', 'fr', 'it'];
const OUT = new URL('../public/peaks/', import.meta.url);
const STATE = new URL('blocks.json', OUT);
const started = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const left = () => BUDGET_MS - (Date.now() - started);

function parseEle(raw) {
  if (!raw) return null;
  const m = raw.replace(/['’\s]/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let v = parseFloat(m[0]);
  if (/ft|feet/.test(raw)) v *= 0.3048;
  return Number.isFinite(v) && v > -500 && v < 9000 ? Math.round(v) : null;
}

/** CSV für ein Rechteck der Kantenlänge `size`; null, wenn kein Server antwortet. */
async function query(s, w, size) {
  const fields = ['::id', '::lat', '::lon', 'ele', 'name', ...LANGS.map((l) => `"name:${l}"`)].join(',');
  const q = `[out:csv(${fields};false;"\\t")][timeout:90][bbox:${s},${w},${s + size},${w + size}];node["natural"="peak"]["name"];out qt;`;
  for (const ep of ENDPOINTS) {
    const timeout = Math.min(100_000, left());
    if (timeout < 20_000) return null;
    try {
      const res = await fetch(ep, {
        method: 'POST',
        body: new URLSearchParams({ data: q }),
        headers: { 'User-Agent': 'ridge-lens-build (github.com/jibes/ridge-lens)' },
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.text();
      if (!res.ok || /<html|runtime error/i.test(text.slice(0, 500))) throw new Error(`HTTP ${res.status}`);
      return text;
    } catch (err) {
      console.warn(`  ${new URL(ep).hostname}: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`);
    }
  }
  return null;
}

/** Zeilen eines Blocks nach 1°-Kacheln; Grenzpunkte gehören nur zur Kachel im Block. */
function toTiles(text, s, w) {
  const tiles = new Map();
  for (const line of text.split('\n')) {
    const [id, lat, lon, ele, name, ...names] = line.split('\t');
    if (!name || !lat || !lon) continue;
    const la = Number(lat);
    const lo = Number(lon);
    if (la < s || la >= s + BLOCK || lo < w || lo >= w + BLOCK) continue;
    const key = `${Math.floor(la)}_${Math.floor(lo)}`;
    if (!tiles.has(key)) tiles.set(key, new Map());
    tiles.get(key).set(id, [Number(id), +la.toFixed(5), +lo.toFixed(5), parseEle(ele), name, ...LANGS.map((_, i) => names[i] ?? '')]);
  }
  return tiles;
}

async function writeIndex(state) {
  const tiles = (await readdir(OUT)).filter((f) => /^-?\d+_-?\d+\.json$/.test(f)).map((f) => f.slice(0, -5));
  await writeFile(STATE, JSON.stringify(state));
  await writeFile(
    new URL('index.json', OUT),
    JSON.stringify({ generated: new Date().toISOString(), region: REGION, blockSize: BLOCK, blocks: Object.keys(state).sort(), tiles: tiles.sort() }),
  );
}

await mkdir(OUT, { recursive: true });
const state = JSON.parse(await readFile(STATE, 'utf8').catch(() => '{}'));

const blocks = [];
for (let s = REGION.south; s < REGION.north; s += BLOCK) {
  for (let w = REGION.west; w < REGION.east; w += BLOCK) blocks.push([s, w]);
}
const age = (key) => (state[key] ? (Date.now() - Date.parse(state[key])) / 86_400_000 : Infinity);
const dist = ([s, w]) => Math.hypot(s + BLOCK / 2 - CENTER.lat, (w + BLOCK / 2 - CENTER.lon) * 0.7);
/**
 * CSV eines 2°-Blocks. Dichte Blöcke laufen bei überlasteten Servern ins Timeout;
 * dann in vier 1°-Teilabfragen zerlegen. Null, wenn ein Teil fehlt.
 */
async function fetchBlock(s, w) {
  const whole = await query(s, w, BLOCK);
  if (whole !== null) return whole;
  console.warn(`block ${s},${w}: splitting into 1° parts`);
  const parts = [];
  for (let la = s; la < s + BLOCK; la++) {
    for (let lo = w; lo < w + BLOCK; lo++) {
      const part = await query(la, lo, 1);
      if (part === null) return null;
      parts.push(part);
      await sleep(PAUSE_MS);
    }
  }
  return parts.join('\n');
}

const todo = blocks
  .filter(([s, w]) => age(`${s}_${w}`) > MAX_AGE_DAYS)
  // fehlende zuerst, dann älteste; innerhalb davon von der Mitte nach außen
  .sort((a, b) => Number(!!state[`${a[0]}_${a[1]}`]) - Number(!!state[`${b[0]}_${b[1]}`]) || dist(a) - dist(b));

console.log(`${blocks.length - todo.length}/${blocks.length} blocks current, ${todo.length} to fetch`);
let fetched = 0;
for (const [s, w] of todo) {
  if (left() < 30_000) break;
  const text = await fetchBlock(s, w);
  if (text === null) {
    console.warn(`block ${s},${w}: skipped`);
    await sleep(5_000);
    continue;
  }
  const tiles = toTiles(text, s, w);
  let count = 0;
  // alle 1°-Kacheln des Blocks neu schreiben (auch leere, damit veraltete verschwinden)
  for (let la = s; la < s + BLOCK; la++) {
    for (let lo = w; lo < w + BLOCK; lo++) {
      const rows = [...(tiles.get(`${la}_${lo}`)?.values() ?? [])];
      count += rows.length;
      await writeFile(new URL(`${la}_${lo}.json`, OUT), JSON.stringify(rows));
    }
  }
  state[`${s}_${w}`] = new Date().toISOString();
  await writeIndex(state);
  fetched++;
  console.log(`block ${s},${w}: ${count} peaks`);
  await sleep(PAUSE_MS); // Overpass schonen
}
await writeIndex(state);
const done = blocks.filter(([s, w]) => state[`${s}_${w}`]).length;
console.log(`fetched ${fetched} blocks; ${done}/${blocks.length} available`);
