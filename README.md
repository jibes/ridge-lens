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

Beim Öffnen: Bildschirm bleibt an (Screen Wake Lock), Standort per GPS, auf Touch-Geräten Sensoren an – ohne Knopf. Der Sensormodus beginnt mit den ersten Orientierungsdaten; iOS holt die Erlaubnis bei der ersten Berührung nach. Ohne Sensordaten (z. B. Brave) bleibt der manuelle Modus. Ohne GPS-Freigabe wird der Ort aus dem Link bzw. Rigi Kulm gezeigt.

## Bedienung

Vollbild-Panorama, unten zwei Knöpfe: Einstellungen (Ort, Koordinaten, Höhe, Sichtweite, Kompass-Korrektur, Installieren) und Standort neu bestimmen. Farben folgen dem Hell-/Dunkelmodus des Systems. Ohne Sensor: ziehen, Pinch/Mausrad, 360°-Übersicht antippen.

## Sprachen

Deutsch, Englisch, Französisch, Italienisch – automatisch nach Systemsprache (sonst Englisch), umstellbar in den Einstellungen. Gipfelnamen erscheinen in der gewählten Sprache, falls OSM sie führt (`name:xx`), sonst ortsüblich. Texte in `src/i18n.ts`; der Worker meldet nur Schlüssel.

## App installieren

Android (Chrome/Brave): Knopf „Installieren“ oder Browsermenü → „Zum Startbildschirm hinzufügen“. iOS (Safari): Teilen → „Zum Home-Bildschirm“.

Der Service Worker (`public/sw.js`) hält die App-Shell und alle geladenen Höhenkacheln im Cache; Gipfel liegen im Cache der App. Einmal mit Netz berechnete Standorte funktionieren danach offline.

## Sensormodus

Der Blick folgt dem Handy, das Fadenkreuz markiert die Blickrichtung der Rückkamera.

Kompass korrigieren:
- **Anpeilen:** Gipfel-Label antippen → Fadenkreuz auf den echten Gipfel richten → „Übernehmen“. Setzt Korrektur für Kurs und Neigung.
- **Feinjustieren:** Ziehen verschiebt im Sensormodus die Korrektur statt des Blicks (Pfeiltasten: 0,2°-Schritte).

Die Korrektur bleibt im Browser gespeichert. Sie enthält auch die magnetische Missweisung (Alpen ≈ +3°), die Handy-Kompasse nicht abziehen.

Technik (`src/orientation.ts`): Rotationsmatrix aus α/β/γ (W3C), Blickachse = −z des Geräts, Rolle relativ zum Horizont, Bildschirmdrehung (Querformat) berücksichtigt. Kurs per Sensorfusion (Komplementärfilter, `HeadingFusion`): Der ruhige Gyro-Kurs (Android: relatives `deviceorientation`; iOS: relatives α) bestimmt die Bewegung, der verrauschte Kompass (`deviceorientationabsolute` bzw. `webkitCompassHeading`) nur langsam (τ ≈ 4 s) den Nordbezug. Ohne Gyro-Strom wird der Kompass direkt genutzt. Danach One-Euro-Filter je Achse (reiner Kompass-Kurs am trägsten). Einstellungen zeigen das Rauschen je Achse (Diagnose); gemessen am Handy: Kompass ±0,4–0,8°, Neigung/Rolle ≤ 0,1°.

## Funktionsweise

- **Höhenmodell:** [Terrarium-Kacheln](https://github.com/tilezen/joerd) von AWS; Zoom 12 (≈ 26 m) bis 8 km, Zoom 10 (≈ 100 m) darüber hinaus.
- **Raycasting** (Web Worker, `src/worker.ts`): 3600 Strahlen à 0,1°, Höhenwinkel mit Erdkrümmung und Refraktion (k = 0,13). Kammlinie = letzter sichtbarer Punkt vor einem verdeckten Abschnitt (`src/panorama.ts`); benachbarte Kammpunkte ähnlicher Distanz werden zu Linien verbunden.
- **Gipfel:** Mitgelieferter Datensatz für Alpen und Umgebung (42–50° N, 2–18° O) in 1°-Kacheln unter `peaks/`, erzeugt im CI von `scripts/build-peaks.mjs` aus OSM (`natural=peak` mit Name; inkrementell über tägliche CI-Läufe, Blöcke älter als 30 Tage werden erneuert). Außerhalb davon live über Overpass (Rechteck-Abfrage, CSV, vier Server nacheinander mit 30-s-Timeout), im Browser-Cache abgelegt. Sichtbar, wenn Höhenwinkel ≥ maximaler Geländewinkel davor. OSM-Höhe wird bevorzugt, außer sie weicht > 400 m vom DEM ab.
- **Projektion** (`src/projection.ts`): Lochkamera mit Blickrichtung, Neigung und Sichtfeld – dasselbe Modell wie später für das Kamerabild.

## Bekannte Grenzen

- DEM glättet Gipfel (Rigi: max. 1758 statt 1797 m). Abhilfe: Liegt ein OSM-Gipfel mit Höhe < 80 m entfernt, gilt dessen Höhe; sonst, falls das Gelände ringsum abfällt, die höchste DEM-Stelle im Umkreis von 40 m. GPS-Höhe wird nicht verwendet (ellipsoidisch, in der Schweiz ≈ 50 m zu hoch). Manuelle Höhe in den Einstellungen hat Vorrang.
- Kammlinien enthalten noch kurze Fragmente; Gipfel-Labels werden nur nach Höhe ausgedünnt.

## Nächste Stufen

1. ~~Geräteorientierung steuert den Blick; Kompass-Korrektur.~~
2. Kamerabild unter dem Overlay, Sichtfeld-Kalibrierung.
3. Automatischer Abgleich: Skyline aus dem Kamerabild gegen berechneten Horizont korrelieren.

## Datenquellen

Höhendaten: AWS Terrain Tiles ([Quellen](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)). Gipfel: © OpenStreetMap-Mitwirkende, ODbL.
