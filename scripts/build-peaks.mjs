// Gipfel-Datensatz weltweit: alle benannten OSM-Gipfel und Vulkane (natural=peak, volcano) als 1°-Kacheln nach
// public/peaks/. Quelle ist ein Auszug aus der OSM-Weltdatei, den der Workflow mit osmium
// erzeugt (PEAKS_OSM_GEOJSONSEQ, siehe peaks.yml; monatlich). Die Bekanntheit (Wikidata-
// Sitelinks) kommt vom Wikidata Query Service und wird in fame.json zwischengespeichert;
// jeder Lauf ergänzt fehlende Werte im Zeitbudget.
//
// Kachel:     [[id, lat, lon, ele|null, name, de, en, fr, it, fame, qid?], …] (leere Namen = "")
//             fame = Zahl der Wikidata-Sitelinks (1 = Verweis, noch unbekannt; 0 = kein Verweis)
// index.json: { generated, coverage: "global", osm, tiles: ["46_8", …] } (Kacheln ohne Gipfel fehlen)
// meta.json:  { osm: Zeitpunkt des Auszugs }
// fame.json:  { Q1374: 75, … } (nur für den Build, wird nicht veröffentlicht)
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const WIKIDATA_SPARQL = process.env.WIKIDATA_SPARQL ?? 'https://query.wikidata.org/sparql';
const BUDGET_MS = Number(process.env.PEAKS_BUDGET_MIN ?? 40) * 60_000;
const LANGS = ['de', 'en', 'fr', 'it'];
const HEADERS = { 'User-Agent': 'ridge-lens-build (github.com/jibes/ridge-lens)' };
const OUT = new URL('../public/peaks/', import.meta.url);
const started = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const left = () => BUDGET_MS - (Date.now() - started);
const readJson = async (name, fallback) => JSON.parse(await readFile(new URL(name, OUT), 'utf8').catch(() => 'null')) ?? fallback;

function parseEle(raw) {
  if (!raw) return null;
  const m = raw.replace(/['’\s]/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let v = parseFloat(m[0]);
  if (/ft|feet/.test(raw)) v *= 0.3048;
  return Number.isFinite(v) && v > -500 && v < 9000 ? Math.round(v) : null;
}

/**
 * Gipfel aus dem osmium-Auszug (GeoJSON-Sequenz, eine Zeile je Knoten, Kennung "n123"
 * per --add-unique-id=type_id). Zeilenweise gelesen: global rund 1 Mio. Zeilen.
 */
export async function readExtract(path) {
  const rows = new Map();
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const raw of lines) {
    const line = raw.replace(/^\x1e/, '').trim();
    if (!line) continue;
    let f;
    try {
      f = JSON.parse(line);
    } catch {
      continue;
    }
    const id = Number(/^n(\d+)$/.exec(String(f.id ?? ''))?.[1]);
    const [lon, lat] = f.geometry?.type === 'Point' ? f.geometry.coordinates : [];
    const t = f.properties ?? {};
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon) || !t.name || rows.has(id)) continue;
    const qid = /^Q\d+$/.test(t.wikidata ?? '') ? t.wikidata : '';
    rows.set(id, { id, lat, lon, ele: parseEle(t.ele), name: t.name, names: LANGS.map((l) => t[`name:${l}`] ?? ''), qid });
  }
  return [...rows.values()];
}

/**
 * Bekanntheit je Wikidata-Id: Zahl der Sitelinks (vorberechnet als wikibase:sitelinks),
 * 400 Ids je Abfrage; nach drei Fehlschlägen in Folge Abbruch (nächster Lauf macht weiter).
 */
async function sitelinkCounts(ids, onBatch) {
  let failures = 0;
  for (let i = 0; i < ids.length && failures < 3; i += 400) {
    if (left() < 90_000) break;
    const values = ids.slice(i, i + 400).map((q) => `wd:${q}`).join(' ');
    const query = `SELECT ?item ?n WHERE { VALUES ?item { ${values} } ?item wikibase:sitelinks ?n }`;
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const res = await fetch(WIKIDATA_SPARQL, {
          method: 'POST',
          body: new URLSearchParams({ query, format: 'json' }),
          headers: { ...HEADERS, Accept: 'application/sparql-results+json' },
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 429 || res.status === 503) {
          const wait = Math.min(60, Number(res.headers.get('retry-after')) || 10);
          console.warn(`  wikidata: HTTP ${res.status}, warte ${wait} s`);
          await sleep(wait * 1000);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const batch = new Map(body.results.bindings.map((b) => [b.item.value.replace(/^.*\//, ''), Number(b.n.value)]));
        // Ids ohne Treffer (gelöscht/umgeleitet) als 1 merken, sonst würden sie endlos neu abgefragt
        for (const q of ids.slice(i, i + 400)) if (!batch.has(q)) batch.set(q, 1);
        await onBatch(batch);
        ok = true;
      } catch (err) {
        console.warn(`  wikidata: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`);
      }
    }
    failures = ok ? 0 : failures + 1;
    await sleep(500);
  }
}

/** Bisherige Gipfel aus den Kacheln (für Läufe ohne neue OSM-Abfrage). */
async function rowsFromTiles() {
  const rows = [];
  for (const f of await readdir(OUT)) {
    if (!/^-?\d+_-?\d+\.json$/.test(f)) continue;
    for (const r of JSON.parse(await readFile(new URL(f, OUT), 'utf8'))) {
      rows.push({ id: r[0], lat: r[1], lon: r[2], ele: r[3], name: r[4], names: r.slice(5, 9), qid: r[10] ?? '' });
    }
  }
  return rows;
}

await mkdir(OUT, { recursive: true });
const meta = await readJson('meta.json', {});
const index = await readJson('index.json', null);
const fame = await readJson('fame.json', {});
const extract = process.env.PEAKS_OSM_GEOJSONSEQ;

let rows;
if (extract) {
  rows = await readExtract(extract);
  console.log(`Auszug: ${rows.length} benannte Gipfel`);
  if (rows.length < Number(process.env.PEAKS_MIN_ROWS ?? 100_000)) {
    throw new Error(`nur ${rows.length} Gipfel im Auszug – Datensatz bleibt unverändert`);
  }
  meta.osm = new Date().toISOString();
} else if (index?.coverage === 'global') {
  rows = await rowsFromTiles();
  console.log(`OSM-Stand vom ${meta.osm}, ${rows.length} Gipfel aus den Kacheln`);
} else {
  // Noch kein globaler Datensatz und kein Auszug: den bisherigen nicht anrühren
  console.log('Kein Planet-Auszug und noch kein globaler Datensatz – nichts zu tun');
  process.exit(0);
}

// Bekanntheit ergänzen, Zwischenstand nach jeder Abfrage sichern
const missing = [...new Set(rows.map((r) => r.qid).filter((q) => q && !(q in fame)))];
const withQid = new Set(rows.map((r) => r.qid).filter(Boolean)).size;
console.log(`${rows.length} Gipfel, ${withQid} mit Wikidata, davon ${missing.length} ohne Bekanntheit`);
let resolved = 0;
await sitelinkCounts(missing, async (batch) => {
  for (const [q, n] of batch) fame[q] = n;
  resolved += batch.size;
  await writeFile(new URL('fame.json', OUT), JSON.stringify(fame));
});
console.log(`  wikidata: ${resolved}/${missing.length} ergänzt`);

// Kacheln schreiben (nur geänderte), verwaiste entfernen
const tiles = new Map();
for (const r of rows) {
  const key = `${Math.floor(r.lat)}_${Math.floor(r.lon)}`;
  if (!tiles.has(key)) tiles.set(key, []);
  const row = [r.id, +r.lat.toFixed(5), +r.lon.toFixed(5), r.ele, r.name, ...r.names, r.qid ? (fame[r.qid] ?? 1) : 0];
  if (r.qid) row.push(r.qid);
  tiles.get(key).push(row);
}
let changed = 0;
for (const [key, list] of tiles) {
  list.sort((a, b) => a[0] - b[0]);
  const json = JSON.stringify(list);
  const file = new URL(`${key}.json`, OUT);
  if ((await readFile(file, 'utf8').catch(() => '')) === json) continue;
  await writeFile(file, json);
  changed++;
}
for (const f of await readdir(OUT)) {
  const tile = /^(-?\d+_-?\d+)\.json$/.exec(f)?.[1];
  if ((tile && !tiles.has(tile)) || f === 'blocks.json') {
    await rm(new URL(f, OUT));
    changed++;
  }
}
const keys = [...tiles.keys()].sort();
const sameTiles = index?.coverage === 'global' && JSON.stringify(index.tiles) === JSON.stringify(keys);
if (changed || !sameTiles || index?.osm !== meta.osm) {
  await writeFile(new URL('index.json', OUT), JSON.stringify({ generated: new Date().toISOString(), coverage: 'global', osm: meta.osm, tiles: keys }));
  await writeFile(new URL('meta.json', OUT), JSON.stringify(meta));
}
console.log(`${keys.length} Kacheln, ${changed} geändert; Bekanntheit fehlt noch für ${missing.length - resolved} Ids`);
