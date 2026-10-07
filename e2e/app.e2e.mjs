// Ende-zu-Ende-Test der App im Browser (Chromium, Handy-Ansicht): Start, Panorama,
// Sensor-Drehung, Ebenen-Menü, manueller Modus, Kamera mit Wiederaufnahme.
// Höhenkacheln und Overpass werden abgefangen (synthetisches Gelände), damit der Test
// ohne Netz und reproduzierbar läuft. Aufruf: npm run e2e (baut vorher nicht selbst).
import { spawn } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright-core';

const PORT = 4179;
const BASE = `http://localhost:${PORT}/`;
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};

// --- Synthetisches Terrarium-PNG: Kegelberg mitten in jeder Kachel ---------------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
function terrariumPng() {
  const raw = Buffer.alloc(256 * (1 + 256 * 3));
  for (let y = 0; y < 256; y++) {
    raw[y * 769] = 0;
    for (let x = 0; x < 256; x++) {
      const d = Math.hypot(x - 128, y - 128) / 128;
      const h = 1000 + 1500 * Math.max(0, 1 - d) + 32768;
      const p = y * 769 + 1 + x * 3;
      raw[p] = Math.floor(h / 256);
      raw[p + 1] = Math.floor(h) % 256;
      raw[p + 2] = Math.floor((h % 1) * 256);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(256, 0);
  ihdr.writeUInt32BE(256, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const TILE = terrariumPng();

// --- Server und Browser -------------------------------------------------------------
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const stop = () => server.kill();
process.on('exit', stop);
for (let i = 0; i < 50; i++) {
  if (await fetch(BASE).then((r) => r.ok).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({
  viewport: { width: 412, height: 900 },
  isMobile: true,
  hasTouch: true,
  locale: 'de-DE',
  permissions: ['camera'],
  serviceWorkers: 'block',
});
await ctx.route('**/elevation-tiles-prod/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: TILE, headers: { 'access-control-allow-origin': '*' } }));
// Bahnelemente der ISS (sonst vom Workflow); Epoche 6.10.2026
await ctx.route('**/peaks/sats.json', (r) =>
  r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      sats: [
        {
          n: 'ISS (ZARYA)',
          l1: '1 25544U 98067A   26279.50000000  .00016717  00000-0  10270-3 0  9005',
          l2: '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50377579 99999',
        },
      ],
    }),
  }),
);
await ctx.route(/overpass|maps\.mail\.ru/, (r) => r.fulfill({ status: 200, contentType: 'text/plain', body: '', headers: { 'access-control-allow-origin': '*' } }));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  await page.goto(BASE);

  // 1. Panorama wird berechnet
  await page.waitForFunction(() => /m ü\. M\./.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 }).catch(() => {});
  check(/m ü\. M\./.test(await page.textContent('#status')), 'Panorama berechnet (Statuszeile mit Höhe)');

  // 2. Sensoren: Drehung des Geräts dreht die Ansicht (Regression: eingefrorener Kompass)
  const turn = (alpha) =>
    page.evaluate(async (alpha) => {
      for (let i = 0; i < 15; i++) {
        for (const type of ['deviceorientationabsolute', 'deviceorientation']) {
          const ev = new Event(type);
          Object.assign(ev, { alpha, beta: 90, gamma: 0, absolute: type === 'deviceorientationabsolute' });
          window.dispatchEvent(ev);
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      await new Promise((r) => setTimeout(r, 300));
      return document.getElementById('sensor-text')?.textContent ?? '';
    }, alpha);
  const a = await turn(0);
  const b = await turn(90);
  const deg = (s) => Number(/(\d+)°/.exec(s)?.[1]);
  check(!Number.isNaN(deg(a)) && !Number.isNaN(deg(b)), `Kompass-Anzeige vorhanden („${a}“ → „${b}“)`);
  check(Math.abs(((deg(a) - deg(b) + 540) % 360) - 180) > 60, 'Drehung um 90° ändert den Kurs');

  // 3. Ebenen-Menü
  await page.click('#layers-open');
  check(!(await page.isHidden('#layers-menu')), 'Ebenen-Menü klappt auf');
  await page.click('#layer-sky');
  check((await page.getAttribute('#layer-sky', 'aria-pressed')) === 'false', 'Himmel ausgeblendet');
  check(!(await page.isChecked('#show-sky')), 'Einstellung „Himmel anzeigen“ folgt dem Menü');
  await page.mouse.click(200, 300);
  check(await page.isHidden('#layers-menu'), 'Tippen daneben schließt das Menü');

  // 3b. Suche nach Himmelskörpern nur bei eingeblendetem Himmel
  const search = async (q) => {
    await page.click('#search-open');
    await page.fill('#search-input', q);
    await page.waitForTimeout(200);
    const items = await page.$$eval('#search-results button', (bs) => bs.map((b) => b.textContent));
    await page.click('#search-close');
    return items;
  };
  check(!(await search('Jupiter')).some((x) => /Planet/.test(x)), 'Himmel aus: Jupiter nicht in der Suche');
  await page.click('#layers-open');
  await page.click('#layer-sky');
  await page.mouse.click(200, 300);
  const mars = await search('Mars');
  check(mars.some((x) => /Mars.*Planet/.test(x)), `Himmel an: Mars als Planet gefunden (${mars[0] ?? '–'})`);
  await page.click('#search-open');
  await page.fill('#search-input', 'Mond');
  await page.waitForTimeout(200);
  await page.click('#search-results button');
  await page.waitForTimeout(300);
  check(!(await page.isHidden('#target')), 'Mond als Ziel gewählt: Ziel-Chip sichtbar');
  await page.click('#target-close');
  const iss = await search('ISS');
  check(iss.some((x) => /ISS.*Satellit.*(Überflug|kein Überflug|°)/.test(x)), `ISS als Satellit mit Überflug gefunden (${iss[0] ?? '–'})`);
  const mw = await search('Milchstr');
  check(mw.some((x) => /Zentrum der Milchstraße/.test(x)), 'Zentrum der Milchstraße suchbar');

  // 4. Manueller Modus zeigt bzw. verbirgt die Werkzeuge
  await page.click('#menu');
  check(await page.isHidden('#manual-tools'), 'Manuelle Werkzeuge standardmäßig verborgen');
  await page.check('#manual-cal');
  check(!(await page.isHidden('#manual-tools')), 'Manueller Modus zeigt die Werkzeuge');
  await page.uncheck('#manual-cal');
  await page.evaluate(() => (document.getElementById('panel').scrollTop = 99999));
  const closeBox = await page.locator('#panel-close').boundingBox();
  const panelBox = await page.locator('#panel').boundingBox();
  check(!!closeBox && !!panelBox && closeBox.y >= panelBox.y - 1 && closeBox.y < panelBox.y + 60, 'Schließkreuz bleibt beim Scrollen oben sichtbar');
  await page.mouse.click(200, 150);
  check(await page.isHidden('#panel'), 'Tippen außerhalb schließt die Einstellungen');
  check(await page.isHidden('#align'), 'Tippen außerhalb wählt nichts aus');
  await page.click('#menu');
  const swiped = await page.evaluate(async () => {
    const panel = document.getElementById('panel');
    panel.scrollTop = 0;
    const touch = (y) => new Touch({ identifier: 1, target: panel, clientX: 200, clientY: y });
    panel.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(400)], bubbles: true }));
    for (const y of [430, 480, 530]) panel.dispatchEvent(new TouchEvent('touchmove', { touches: [touch(y)], bubbles: true }));
    panel.dispatchEvent(new TouchEvent('touchend', { touches: [], bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    return panel.hidden;
  });
  check(swiped, 'Herunterwischen schließt die Einstellungen');

  // 5. Kamera: läuft, und nach Hintergrund/Vordergrund wieder
  const videoTime = () => page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
  await page.waitForTimeout(1500);
  const t0 = await videoTime();
  await page.waitForTimeout(800);
  check((await videoTime()) > t0, 'Kamerabild läuft');
  const setHidden = (h) =>
    page.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, h);
  await setHidden(true);
  await page.waitForTimeout(300);
  await setHidden(false);
  await page.waitForTimeout(1500);
  const t1 = await videoTime();
  await page.waitForTimeout(800);
  check((await videoTime()) > t1, 'Kamerabild läuft nach Rückkehr in den Vordergrund weiter');

  check(errors.length === 0, `keine Skriptfehler${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  stop();
}
console.log(failures ? `${failures} Prüfung(en) fehlgeschlagen` : 'Alle Prüfungen bestanden');
process.exit(failures ? 1 : 0);
