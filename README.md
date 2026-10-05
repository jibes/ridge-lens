# Ridge Lens

Bergpanorama im Browser: berechnet aus Standort und Höhenmodell die sichtbaren Bergketten und beschriftet die Gipfel. Ziel ist ein AR-Overlay auf das Kamerabild; Stufe 1 läuft noch ohne Kamera.

## Entwicklung

```sh
npm install
npm run dev      # http://localhost:5173
npm test         # Geometrie- und Raycasting-Tests
npm run build    # nach dist/
```

Zustand steckt in der URL: `#lat,lon,höhe,blickrichtung,sichtfeld`, z. B. `#47.0566,8.4851,1797,213,20` (Rigi Kulm, Blick auf die Jungfrau). Höhe leer lassen = aus dem Höhenmodell.

## Funktionsweise

- **Höhenmodell:** [Terrarium-Kacheln](https://github.com/tilezen/joerd) von AWS; Zoom 12 (≈ 26 m) bis 8 km, Zoom 10 (≈ 100 m) darüber hinaus.
- **Raycasting** (Web Worker, `src/worker.ts`): 3600 Strahlen à 0,1°, Höhenwinkel mit Erdkrümmung und Refraktion (k = 0,13). Kammlinie = letzter sichtbarer Punkt vor einem verdeckten Abschnitt (`src/panorama.ts`); benachbarte Kammpunkte ähnlicher Distanz werden zu Linien verbunden.
- **Gipfel:** OSM `natural=peak` über Overpass, im Browser-Cache abgelegt. Sichtbar, wenn Höhenwinkel ≥ maximaler Geländewinkel davor. OSM-Höhe wird bevorzugt, außer sie weicht > 400 m vom DEM ab.
- **Projektion** (`src/projection.ts`): Lochkamera mit Blickrichtung, Neigung und Sichtfeld – dasselbe Modell wie später für das Kamerabild.

## Bekannte Grenzen

- DEM glättet Gipfel: auf einem Gipfel liegt die DEM-Höhe oft 30–60 m zu tief (Rigi: 1743 statt 1797 m). Für Gipfelstandorte Höhe manuell eintragen, sonst verdeckt das nahe Gelände den Blick.
- Kammlinien enthalten noch kurze Fragmente; Gipfel-Labels werden nur nach Höhe ausgedünnt.

## Nächste Stufen

1. Geräteorientierung (Kompass, Neigung) steuert den Blick; manueller Kompass-Offset.
2. Kamerabild unter dem Overlay, Sichtfeld-Kalibrierung.
3. Automatischer Abgleich: Skyline aus dem Kamerabild gegen berechneten Horizont korrelieren.

## Datenquellen

Höhendaten: AWS Terrain Tiles ([Quellen](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)). Gipfel: © OpenStreetMap-Mitwirkende, ODbL.
