// Gipfel-Datensatz weltweit: alle benannten OSM-Gipfel (natural=peak) als 1°-Kacheln nach
// public/peaks/. Quelle ist QLever (SPARQL über den kompletten OSM-Bestand, Uni Freiburg):
// eine Abfrage statt tausender Overpass-Blöcke. Die Bekanntheit (Wikidata-Sitelinks) kommt
// vom Wikidata Query Service und wird in fame.json zwischengespeichert; jeder Lauf ergänzt
// fehlende Werte im Zeitbudget. OSM-Daten werden wöchentlich aufgefrischt.
//
// Kachel:     [[id, lat, lon, ele|null, name, de, en, fr, it, fame, qid?], …] (leere Namen = "")
//             fame = Zahl der Wikidata-Sitelinks (1 = Verweis, noch unbekannt; 0 = kein Verweis)
// index.json: { generated, coverage: "global", osm, tiles: ["46_8", …] } (Kacheln ohne Gipfel fehlen)
// meta.json:  { osm: Zeitpunkt der OSM-Abfrage }
// fame.json:  { Q1374: 75, … } (nur für den Build, wird nicht veröffentlicht)
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';

const QLEVER = process.env.QLEVER_API ?? 'https://qlever.cs.uni-freiburg.de/api/osm-planet';
const WIKIDATA_SPARQL = process.env.WIKIDATA_SPARQL ?? 'https://query.wikidata.org/sparql';
const BUDGET_MS = Number(process.env.PEAKS_BUDGET_MIN ?? 40) * 60_000;
const OSM_MAX_AGE_DAYS = 7;
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

/** Ein Feld der QLever-TSV-Ausgabe: <IRI>, "Literal"@lang / "Literal"^^<typ> oder leer. */
export function parseTerm(t) {
  if (!t) return '';
  if (t.startsWith('<') && t.endsWith('>')) return t.slice(1, -1);
  if (t.startsWith('"')) {
    const end = t.lastIndexOf('"');
    return t
      .slice(1, end > 0 ? end : undefined)
      .replace(/\\(.)/g, (_, c) => ({ t: '\t', n: '\n', r: '\r' })[c] ?? c);
  }
  return t;
}

/** Zeilen aus der QLever-TSV-Ausgabe (Spalten wie in der SELECT-Klausel). */
export function parseOsmTsv(text) {
  const rows = new Map();
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const [node, wkt, ele, name, ...rest] = lines[i].split('\t').map(parseTerm);
    const id = Number(/\/node\/(\d+)$/.exec(node)?.[1]);
    const pt = /POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/.exec(wkt);
    if (!id || !pt || !name || rows.has(id)) continue;
    const qid = /^Q\d+$/.test(rest[LANGS.length] ?? '') ? rest[LANGS.length] : '';
    rows.set(id, { id, lat: Number(pt[2]), lon: Number(pt[1]), ele: parseEle(ele), name, names: LANGS.map((_, k) => rest[k] ?? ''), qid });
  }
  return [...rows.values()];
}

const PREFIXES = `PREFIX osmkey: <https://www.openstreetmap.org/wiki/Key:>
PREFIX osmnode: <https://www.openstreetmap.org/node/>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>`;

async function qlever(query, { tsv = true, timeoutMs = 20 * 60_000 } = {}) {
  const res = await fetch(QLEVER, {
    method: 'POST',
    body: new URLSearchParams({ query, ...(tsv ? { action: 'tsv_export' } : {}), timeout: '1200s' }),
    headers: { ...HEADERS, Accept: tsv ? 'text/tab-separated-values' : 'application/sparql-results+json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`QLever HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

/** Alle benannten Gipfel weltweit; bei leerem Ergebnis Schema-Diagnose ins Log. */
async function fetchOsm() {
  const opt = LANGS.map((l, k) => `OPTIONAL { ?node osmkey:name:${l} ?n${k} }`).join(' ');
  const query = `${PREFIXES}
SELECT ?node ?wkt ?ele ?name ${LANGS.map((_, k) => `?n${k}`).join(' ')} ?wd WHERE {
  ?node osmkey:natural "peak" ; osmkey:name ?name ; geo:hasGeometry/geo:asWKT ?wkt .
  OPTIONAL { ?node osmkey:ele ?ele } ${opt} OPTIONAL { ?node osmkey:wikidata ?wd }
}`;
  const t0 = Date.now();
  const text = await qlever(query);
  console.log(`QLever: ${(text.length / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log(text.split('\n').slice(0, 3).join('\n'));
  const rows = parseOsmTsv(text);
  if (rows.length < Number(process.env.PEAKS_MIN_ROWS ?? 100_000)) {
    // Schema prüfen: alle Aussagen zum Matterhorn-Knoten
    const probe = await qlever(`${PREFIXES}\nSELECT ?p ?o WHERE { osmnode:26863664 ?p ?o } LIMIT 60`).catch((e) => String(e));
    console.log(`Diagnose Matterhorn-Knoten:\n${probe.slice(0, 4000)}`);
    throw new Error(`nur ${rows.length} Gipfel – Abfrage oder Schema passt nicht, Datensatz bleibt unverändert`);
  }
  return rows;
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
const osmAge = meta.osm ? (Date.now() - Date.parse(meta.osm)) / 86_400_000 : Infinity;

let rows;
if (index?.coverage !== 'global' || osmAge > OSM_MAX_AGE_DAYS || process.env.PEAKS_FORCE_OSM) {
  rows = await fetchOsm();
  meta.osm = new Date().toISOString();
} else {
  rows = await rowsFromTiles();
  console.log(`OSM-Stand vom ${meta.osm} (${osmAge.toFixed(1)} Tage), ${rows.length} Gipfel aus den Kacheln`);
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
