#!/usr/bin/env bash
# Stellt den Gipfel-Datensatz im Verzeichnis $1 wieder her: vom Branch peaks-data,
# sonst (Erstbefüllung) von der veröffentlichten Seite. Ohne beides bleibt es leer –
# die App fällt dann auf Live-Overpass zurück.
set -uo pipefail
dest=${1:-public/peaks}
mkdir -p "$dest"

if git fetch -q --depth=1 origin peaks-data 2>/dev/null; then
  git archive FETCH_HEAD | tar -x -C "$dest"
  echo "Gipfel-Datensatz vom Branch peaks-data: $(ls "$dest" | wc -l) Dateien"
  exit 0
fi

repo=${GITHUB_REPOSITORY:-jibes/ridge-lens}
site="https://${repo%%/*}.github.io/${repo#*/}/peaks"
if curl -fsS "$site/index.json" -o "$dest/index.json"; then
  curl -fsS "$site/blocks.json" -o "$dest/blocks.json" || true
  for t in $(jq -r '.tiles[]' "$dest/index.json"); do
    curl -fsS "$site/$t.json" -o "$dest/$t.json" || echo "Warnung: $t.json fehlt"
  done
  echo "Gipfel-Datensatz von $site: $(ls "$dest" | wc -l) Dateien"
  [ -n "${GITHUB_ENV:-}" ] && echo "PEAKS_BOOTSTRAPPED=1" >> "$GITHUB_ENV"
else
  rm -f "$dest/index.json"
  echo "Kein Gipfel-Datensatz gefunden; leer"
fi
exit 0
