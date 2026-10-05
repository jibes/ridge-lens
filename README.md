# Ridge Lens

Bergpanorama im Browser: berechnet aus Standort und Höhenmodell die sichtbaren Bergketten und beschriftet die Gipfel. Ziel ist ein AR-Overlay auf das Kamerabild; aktuell ohne Kamera, aber der Blick kann der Handy-Ausrichtung folgen.

## Entwicklung

```sh
npm install
npm run dev      # http://localhost:5173
npm run dev:phone  # HTTPS im LAN (selbstsigniert) – nötig für Sensoren auf dem Handy
npm test         # Geometrie- und Raycasting-Tests
npm run build    # nach dist/
```

Zustand steckt in der URL: `#lat,lon,höhe,blickrichtung,sichtfeld`, z. B. `#47.0566,8.4851,1797,213,20` (Rigi Kulm, Blick auf die Jungfrau). Höhe leer lassen = aus dem Höhenmodell.

## Start

Beim Öffnen: Bildschirm bleibt an (Screen Wake Lock), Standort per GPS, auf Touch-Geräten zusätzlich Sensormodus (iOS: erst nach Tippen auf „Sensor“). Ohne GPS-Freigabe wird der Ort aus dem Link bzw. Rigi Kulm gezeigt; ohne Sensordaten schaltet der Sensormodus nach 3 s ab und die Statuszeile nennt den Grund (z. B. Brave blockiert Bewegungssensoren).

## App installieren

Android (Chrome/Brave): Knopf „Installieren“ oder Browsermenü → „Zum Startbildschirm hinzufügen“. iOS (Safari): Teilen → „Zum Home-Bildschirm“.

Der Service Worker (`public/sw.js`) hält die App-Shell und alle geladenen Höhenkacheln im Cache; Gipfel liegen im Cache der App. Einmal mit Netz berechnete Standorte funktionieren danach offline.

## Sensormodus

„Sensor“ aktiviert die Geräteorientierung (iOS fragt nach Erlaubnis). Der Blick folgt dann dem Handy, das rote Fadenkreuz markiert die Blickrichtung der Rückkamera.

Kompass korrigieren:
- **Anpeilen:** Gipfel-Label antippen → Fadenkreuz auf den echten Gipfel richten → „Übernehmen“. Setzt Korrektur für Kurs und Neigung.
- **Feinjustieren:** Ziehen verschiebt im Sensormodus die Korrektur statt des Blicks (Pfeiltasten: 0,2°-Schritte).

Die Korrektur bleibt im Browser gespeichert. Sie enthält auch die magnetische Missweisung (Alpen ≈ +3°), die Handy-Kompasse nicht abziehen.

Technik (`src/orientation.ts`): Rotationsmatrix aus α/β/γ (W3C), Blickachse = −z des Geräts, Rolle relativ zum Horizont, Bildschirmdrehung (Querformat) berücksichtigt. Android: `deviceorientationabsolute`; iOS: relatives α plus `webkitCompassHeading` als geglätteter Nordbezug. Glättung auf Richtungsvektoren statt Winkeln (kein 0°/360°-Sprung).

## Funktionsweise

- **Höhenmodell:** [Terrarium-Kacheln](https://github.com/tilezen/joerd) von AWS; Zoom 12 (≈ 26 m) bis 8 km, Zoom 10 (≈ 100 m) darüber hinaus.
- **Raycasting** (Web Worker, `src/worker.ts`): 3600 Strahlen à 0,1°, Höhenwinkel mit Erdkrümmung und Refraktion (k = 0,13). Kammlinie = letzter sichtbarer Punkt vor einem verdeckten Abschnitt (`src/panorama.ts`); benachbarte Kammpunkte ähnlicher Distanz werden zu Linien verbunden.
- **Gipfel:** OSM `natural=peak` über Overpass, im Browser-Cache abgelegt. Sichtbar, wenn Höhenwinkel ≥ maximaler Geländewinkel davor. OSM-Höhe wird bevorzugt, außer sie weicht > 400 m vom DEM ab.
- **Projektion** (`src/projection.ts`): Lochkamera mit Blickrichtung, Neigung und Sichtfeld – dasselbe Modell wie später für das Kamerabild.

## Bekannte Grenzen

- DEM glättet Gipfel: auf einem Gipfel liegt die DEM-Höhe oft 30–60 m zu tief (Rigi: 1743 statt 1797 m). Für Gipfelstandorte Höhe manuell eintragen, sonst verdeckt das nahe Gelände den Blick.
- Kammlinien enthalten noch kurze Fragmente; Gipfel-Labels werden nur nach Höhe ausgedünnt.

## Nächste Stufen

1. ~~Geräteorientierung steuert den Blick; Kompass-Korrektur.~~
2. Kamerabild unter dem Overlay, Sichtfeld-Kalibrierung.
3. Automatischer Abgleich: Skyline aus dem Kamerabild gegen berechneten Horizont korrelieren.

## Datenquellen

Höhendaten: AWS Terrain Tiles ([Quellen](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)). Gipfel: © OpenStreetMap-Mitwirkende, ODbL.
