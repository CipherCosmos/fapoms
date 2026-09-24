#!/usr/bin/env bash
#
# Fill the India map's data directory: the two map files, the fonts and the map icons.
#
#   deploy/maps/fetch-map-data.sh [data-dir]      # default: $MAP_DATA_DIR, else ~/fapoms-maps
#
# Run once per host, and again whenever a fresher map is wanted (roads and places change; the
# borders do not — they come from deploy/maps/styles/india.json, not from these files). Nothing
# is rendered here: the files are cut out of Protomaps' published OpenStreetMap build by range
# requests, which is why this needs no database, no import and no more than a few minutes.
#
#   india-low.pmtiles     zooms 0-7, the Middle East to South-East Asia   (~10 MB)
#   india-detail.pmtiles  zooms 8-15, India and its borders in full detail (~6 GB)
#
# Licence: the map data is OpenStreetMap (ODbL) via Protomaps — both must be credited on every map,
# which the apps do. Fonts are Noto (OFL), icons are Protomaps' basemaps-assets.
set -euo pipefail

DATA_DIR="${1:-${MAP_DATA_DIR:-$HOME/fapoms-maps}}"
BUILD="${MAP_BUILD:-$(curl -fsS https://build-metadata.protomaps.dev/builds.json | sed -E 's/.*"key":"([0-9]{8}\.pmtiles)".*/\1/')}"
PMTILES_VERSION="1.31.2"
ASSETS_REF="${MAP_ASSETS_REF:-main}"
# Street-level detail needs 15. A lower number is for trying the map out on a laptop.
DETAIL_MAXZOOM="${MAP_DETAIL_MAXZOOM:-15}"

mkdir -p "$DATA_DIR" "$DATA_DIR/fonts" "$DATA_DIR/sprites"
cd "$DATA_DIR"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  PKG="go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz" ;;
  Linux-aarch64) PKG="go-pmtiles_${PMTILES_VERSION}_Linux_arm64.tar.gz" ;;
  Darwin-arm64)  PKG="go-pmtiles-${PMTILES_VERSION}_Darwin_arm64.zip" ;;
  Darwin-x86_64) PKG="go-pmtiles-${PMTILES_VERSION}_Darwin_x86_64.zip" ;;
  *) echo "no pmtiles build for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
if [ ! -x ./pmtiles ]; then
  curl -fsSL -o "$PKG" "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/${PKG}"
  case "$PKG" in *.zip) unzip -o -q "$PKG" pmtiles ;; *) tar -xzf "$PKG" pmtiles ;; esac
  rm -f "$PKG"
fi

SRC="https://build.protomaps.com/${BUILD}"
echo "map build: $BUILD"
# Written beside the live files and swapped in only once complete, so a failed or interrupted
# download never leaves the renderer reading half a file.
./pmtiles extract "$SRC" india-low.pmtiles.new    --bbox=40,-5,110,50 --maxzoom=7
./pmtiles extract "$SRC" india-detail.pmtiles.new --bbox=60,4,100,39  --minzoom=8 --maxzoom="$DETAIL_MAXZOOM"
mv -f india-low.pmtiles.new india-low.pmtiles
mv -f india-detail.pmtiles.new india-detail.pmtiles

curl -fsSL -o assets.tgz "https://codeload.github.com/protomaps/basemaps-assets/tar.gz/${ASSETS_REF}"
tar -xzf assets.tgz --strip-components=1 -C . "basemaps-assets-${ASSETS_REF}/fonts" "basemaps-assets-${ASSETS_REF}/sprites"
cp -f sprites/v4/light* sprites/
rm -f assets.tgz

echo "$BUILD" > BUILD
echo "done: $(du -sh "$DATA_DIR" | cut -f1) in $DATA_DIR — restart india-tiles to pick up new files"
