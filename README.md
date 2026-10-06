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

Vollbild-Panorama, unten Knöpfe für Einstellungen (Ort, Koordinaten, Höhe, Sichtweite, Kompass-Korrektur, Installieren), Suche, Kamera und Standort.

**Suche:** findet geladene Gipfel im Umkreis nach Name oder Übersetzung (ohne Akzente, `src/search.ts`). Der gewählte Gipfel wird Ziel: im Bild mit Ring markiert, außerhalb zeigt ein Pfeil am Rand mit Gradzahl die Drehrichtung (bzw. höher/tiefer), ein Hinweis unten sagt es in Worten, die 360°-Übersicht markiert die Richtung. Ohne Sensor dreht sich der Blick direkt zum Ziel. Farben folgen dem Hell-/Dunkelmodus des Systems. Ohne Sensor: ziehen, Pinch/Mausrad, 360°-Übersicht antippen.

## Sprachen

Deutsch, Englisch, Französisch, Italienisch – automatisch nach Systemsprache (sonst Englisch), umstellbar in den Einstellungen. Gipfelnamen erscheinen in der gewählten Sprache, falls OSM sie führt (`name:xx`), sonst ortsüblich. Texte in `src/i18n.ts`; der Worker meldet nur Schlüssel.

## App installieren

Android (Chrome/Brave): Knopf „Installieren“ oder Browsermenü → „Zum Startbildschirm hinzufügen“. iOS (Safari): Teilen → „Zum Home-Bildschirm“.

Updates: Jeder Build schreibt eine Kennung nach `version.json`. Kehrt man nach einem Deploy in die App zurück, lädt sie sich still neu; bleibt sie offen, erscheint nach spätestens 15 Minuten der Hinweis „Neue Version verfügbar“.

Der Service Worker (`public/sw.js`) hält die App-Shell und alle geladenen Höhenkacheln im Cache; Gipfel liegen im Cache der App. Einmal mit Netz berechnete Standorte funktionieren danach offline.

## Kamerabild

Auf Touch-Geräten liegt das Bild der Rückkamera unter Bergketten und Gipfeln (Knopf in der Leiste schaltet um, Wahl wird gespeichert). Das Sichtfeld der Anzeige folgt aus dem Kamera-Bildwinkel (lange Bildseite, Standard 67° ≈ 26-mm-Hauptkamera) und dem Bildausschnitt (`object-fit: cover`), siehe `src/camera.ts`.

Automatischer Abgleich (`src/vision.ts`, im Worker `src/vision-worker.ts`, abschaltbar in den Einstellungen): einmal pro Sekunde bei ruhig gehaltenem Handy wird das Videobild auf 160 Spalten verkleinert; je Spalte gilt die unterste deutliche Farbkante mit blauem Himmel darüber als Horizont (Suchfenster = wo der berechnete Horizont bei ±12° Kompass- und ±4° Neigungsfehler liegen kann). Eine Suche über Kurs (±12°), Neigung (±4°) und Bildwinkel (±15 %) legt diese Punkte auf den berechneten Horizont (robuste Abweichung: beste 70 % der Spalten). Übernommen wird nur bei guter Deckung (≤ 0,15°), eindeutiger Lösung und deutlich schlechterer Deckung bei ±1,5° Kursversatz – Wald, Gebäude, Nebel, flacher Horizont und gerade Kanten werden verworfen. Treffer gehen zur Hälfte je Durchgang in Kompass-Korrektur und Bildwinkel ein. Synthetische Tests: Kurs ±0,06°, Neigung ±0,02°, Bildwinkel ±0,3 %.

Manuell: Gipfel antippen und anpeilen richtet den Kompass aus; mit zwei Fingern den Bildwinkel anpassen (Wert und Zurücksetzen in den Einstellungen).

## Sonne und Mond

Sonne und Mond (mit Phase) erscheinen an ihrer scheinbaren Position, mit gestrichelter Tagesbahn und Stundenmarken; hinter dem Gelände verdeckt. Berechnung in `src/astro.ts` (Meeus, Sonne ≈ 0,01°, Mond ≈ 0,1° inkl. Parallaxe; Refraktion), geprüft u. a. an drei totalen Sonnenfinsternissen. Die Einstellungen zeigen Auf- und Untergang **über dem echten Gelände** (nicht über dem flachen Horizont). Antippen zeigt Zeiten, Höhe und Beleuchtung; im Sensormodus lässt sich der Kompass daran ausrichten wie an einem Gipfel.

Automatischer Abgleich: Findet sich keine brauchbare Silhouette, dient die Sonne (bzw. nachts der Mond) als Fixpunkt – genau ein heller, runder, kompakter Fleck im Suchfenster um die berechnete Lage, über dem Grat (`detectBody` in `src/vision.ts`). Korrigiert Kurs und Neigung, nicht den Bildwinkel.

## Sterne, Sternbilder, Planeten

Mit der Dämmerung (Sonne unter −4°, voll ab −14°) erscheinen Sterne bis 5,5 mag (Größe/Farbe nach Helligkeit und B−V), Sternbildlinien und -namen in der UI-Sprache, die hellsten Sternnamen und die Planeten Merkur–Saturn – hinter dem Gelände verdeckt. Bei hellem System wechselt die Darstellung nachts ins dunkle Schema. Planeten und helle Sterne lassen sich antippen (Höhe, Helligkeit) und zum Ausrichten des Kompasses verwenden.

In den Einstellungen lässt sich der **Zeitpunkt** wählen (gilt auch für Sonne/Mond und Auf-/Untergänge), z. B. „Wo steht die Milchstraße um 23 Uhr über dem Grat?“.

Technik: `src/nightsky.ts`, Rechnung in `src/astro.ts` (Präzession J2000 → Datum, Planeten nach JPL-Bahnelementen, geprüft u. a. an der Großen Konjunktion 2020 und der Mars-Opposition 2020). Daten `public/sky/sky.json` (≈ 100 KB, gzip 38 KB) aus dem npm-Paket d3-celestial (BSD, Sterne nach XHIP, Sternbilder nach IAU), erzeugt mit `node scripts/build-sky.mjs <d3-celestial/data>`.

## Sensormodus

Der Blick folgt dem Handy, das Fadenkreuz markiert die Blickrichtung der Rückkamera.

Kompass korrigieren:
- **Anpeilen:** Gipfel-Label antippen → Fadenkreuz auf den echten Gipfel richten → „Übernehmen“. Setzt Korrektur für Kurs und Neigung.
- **Feinjustieren:** Ziehen verschiebt im Sensormodus die Korrektur statt des Blicks (Pfeiltasten: 0,2°-Schritte).

Die Korrektur bleibt im Browser gespeichert. Die magnetische Missweisung (Alpen ≈ +3,5°) zieht die App selbst ab: Handy-Kompasse zeigen nach magnetisch Nord, `src/magnetic.ts` rechnet sie für Standort und Datum nach dem World Magnetic Model 2025 (NOAA/BGS, gültig bis 2030; geprüft gegen die offiziellen Testwerte). Ältere gespeicherte Korrekturen, die die Missweisung noch enthielten, werden beim ersten Start umgerechnet.

Technik (`src/orientation.ts`): Rotationsmatrix aus α/β/γ (W3C), Blickachse = −z des Geräts, Rolle relativ zum Horizont, Bildschirmdrehung (Querformat) berücksichtigt. Kurs per Sensorfusion (Komplementärfilter, `HeadingFusion`): Der ruhige Gyro-Kurs (Android: relatives `deviceorientation`; iOS: relatives α) bestimmt die Bewegung, der verrauschte Kompass (`deviceorientationabsolute` bzw. `webkitCompassHeading`) nur langsam (τ ≈ 4 s) den Nordbezug. Ohne Gyro-Strom wird der Kompass direkt genutzt. Danach One-Euro-Filter je Achse (reiner Kompass-Kurs am trägsten). Einstellungen zeigen das Rauschen je Achse (Diagnose); gemessen am Handy: Kompass ±0,4–0,8°, Neigung/Rolle ≤ 0,1°.

## Funktionsweise

- **Höhenmodell:** [Terrarium-Kacheln](https://github.com/tilezen/joerd) von AWS; Zoom 12 (≈ 26 m) bis 8 km, Zoom 10 (≈ 100 m) darüber hinaus.
- **Raycasting** (Web Worker, `src/worker.ts`): 3600 Strahlen à 0,1°, Höhenwinkel mit Erdkrümmung und Refraktion (k = 0,13). Kammlinie = letzter sichtbarer Punkt vor einem verdeckten Abschnitt (`src/panorama.ts`); benachbarte Kammpunkte ähnlicher Distanz werden zu Linien verbunden; fehlt ein Punkt in bis zu zwei Strahlen, wird die Lücke überbrückt. Stücke unter 0,8° Breite fallen weg (Rauschen in der Ferne), außer sie gehören zur Silhouette.
- **Gipfel:** kachelweise (1°) nach Entfernung geladen, eigene Kachel zuerst; das Panorama erscheint sofort, weitere Gipfel kommen nach („Gipfel 3/9“). Quelle je Kachel: mitgelieferter Datensatz → Browser-Cache (30 Tage) → live Overpass (nacheinander, 2 s Pause, vier Server mit Timeout). Gescheiterte Kacheln werden beim nächsten Mal erneut versucht. Sichtbar, wenn Höhenwinkel ≥ maximaler Geländewinkel davor. OSM-Höhe wird bevorzugt, außer sie weicht > 400 m vom DEM ab.
- **Beschriftung:** Liegen Gipfel zu dicht, gewinnt der bekanntere (`labelScore` in `src/render.ts`): Zahl der Wikipedia-Sprachversionen (über den Wikidata-Verweis in OSM), wie weit er über die Silhouette daneben hinausragt, dann Höhe.
- **Gipfel-Datensatz:** Alpen und Umgebung (42–50° N, 2–18° O), erzeugt vom Workflow `peaks.yml` (`scripts/build-peaks.mjs`, täglich, unabhängig vom Deploy) aus OSM (`natural=peak` mit Name, Namen de/en/fr/it, Wikidata-Verweis → Zahl der Wikipedia-Sprachversionen per Wikidata-API) in 2°-Blöcken (bei Überlastung 1°), fehlende und > 30 Tage alte zuerst. Ablage auf Branch `peaks-data` (ein Commit); der Deploy holt ihn per `scripts/restore-peaks.sh` in Sekunden.
- **Projektion** (`src/projection.ts`): Lochkamera mit Blickrichtung, Neigung und Sichtfeld – dasselbe Modell wie später für das Kamerabild.

## Bekannte Grenzen

- DEM glättet Gipfel (Rigi: max. 1758 statt 1797 m). Abhilfe: Liegt ein OSM-Gipfel mit Höhe < 80 m entfernt, gilt dessen Höhe; sonst, falls das Gelände ringsum abfällt, die höchste DEM-Stelle im Umkreis von 40 m. GPS-Höhe wird nicht verwendet (ellipsoidisch, in der Schweiz ≈ 50 m zu hoch). Manuelle Höhe in den Einstellungen hat Vorrang.
- Bekanntheit live geladener Kacheln (außerhalb des Datensatzes) nur grob: Wikidata-Verweis ja/nein.

## Nächste Stufen

1. ~~Geräteorientierung steuert den Blick; Kompass-Korrektur.~~
2. ~~Kamerabild unter dem Overlay, Sichtfeld-Kalibrierung.~~
3. ~~Automatischer Abgleich: Skyline aus dem Kamerabild gegen berechneten Horizont korrelieren.~~ (im Feld zu erproben)

## Datenquellen

Höhendaten: AWS Terrain Tiles ([Quellen](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)). Sterne/Sternbilder: [d3-celestial](https://github.com/ofrohn/d3-celestial) (BSD-3, Olaf Frohn; XHIP, IAU). Gipfel: © OpenStreetMap-Mitwirkende, [ODbL](https://www.openstreetmap.org/copyright); gilt auch für den mitgelieferten Datensatz (`public/peaks`, Branch `peaks-data`).

## Lizenz

© 2026 jibes. Quellcode: [GNU GPL 3.0 oder später](LICENSE) – Weitergaben und veränderte Fassungen müssen samt Quellcode unter derselben Lizenz bleiben. Daten fallen nicht darunter: Gipfel ODbL (OpenStreetMap), Höhendaten siehe Quellen.
