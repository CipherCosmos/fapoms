// Regenerates deploy/maps/styles/india.json — the India map's style.
//
// Run from a scratch directory (it needs @protomaps/basemaps, which is not a dependency of the app):
//   npm i @protomaps/basemaps@4 && cp <repo>/deploy/maps/tools/build-style.mjs . && node build-style.mjs <repo>/deploy/maps
// Input: <maps>/tools/borders-india-pov.geojson (from borders.py). Output: <maps>/styles/india.json.
//
// What it changes from the stock Protomaps "light" style, and why:
//  - OpenStreetMap's national borders (boundaries kind_detail <= 2) are not drawn at all. They follow
//    the de-facto administration: the Line of Control, Aksai Chin outside India.
//  - National borders are drawn from Natural Earth's India point-of-view dataset instead (the land
//    borders between neighbouring countries, computed by borders.py), in the same line style.
//  - Inside the zone around Jammu & Kashmir and Ladakh nothing of the de-facto administration is
//    drawn: no state/province lines, no region labels (no "Gilgit-Baltistan", no "Azad Kashmir").
//  - Two data files: a wide, low-detail one for zooms 0-7 (so a zoomed-out map is never cut off at
//    India's edge) and India in full detail from zoom 8.
import fs from 'node:fs';
import path from 'node:path';
import { layers as basemapLayers, namedFlavor } from '@protomaps/basemaps';

const mapsDir = path.resolve(process.argv[2] ?? '.');
const borders = JSON.parse(fs.readFileSync(path.join(mapsDir, 'tools', 'borders-india-pov.geojson'), 'utf8'));
const ZONE = { type: 'Polygon', coordinates: [[[72.3, 32.25], [80.7, 32.25], [80.7, 37.2], [72.3, 37.2], [72.3, 32.25]]] };
const SPLIT_ZOOM = 8;

function adapt(layer, source, zooms) {
  if (layer.id === 'boundaries_country') {
    return { id: `country_borders_india_pov_${source}`, type: 'line', source: 'india_pov_borders',
      paint: layer.paint, layout: layer.layout ?? {}, ...zooms };
  }
  const next = { ...layer, id: `${layer.id}_${source}`, ...zooms };
  if (layer.id === 'boundaries') next.filter = ['all', ['>', 'kind_detail', 2], ['!', ['within', ZONE]]];
  if (layer.id === 'places_region') next.filter = ['all', ['==', 'kind', 'region'], ['!', ['within', ZONE]]];
  if (layer.type === 'background') return source === 'low' ? { ...layer } : null;
  return next;
}

const flavor = namedFlavor('light');
const low = basemapLayers('low', flavor, { lang: 'en' }).map((l) => adapt(l, 'low', { maxzoom: SPLIT_ZOOM })).filter(Boolean);
const detail = basemapLayers('detail', flavor, { lang: 'en' }).map((l) => adapt(l, 'detail', { minzoom: SPLIT_ZOOM })).filter(Boolean);
// The India-view borders are one source for both ranges; draw them once.
const detailNoBorders = detail.filter((l) => l.source !== 'india_pov_borders');
const lowBorders = low.find((l) => l.source === 'india_pov_borders');
delete lowBorders.maxzoom;

const style = {
  version: 8,
  name: 'FAPOMS India',
  glyphs: '{fontstack}/{range}.pbf',
  sprite: '{styleJsonFolder}/../sprites/light',
  sources: {
    low: { type: 'vector', url: 'pmtiles://{india-low}' },
    detail: { type: 'vector', url: 'pmtiles://{india-detail}' },
    india_pov_borders: { type: 'geojson', data: borders },
  },
  layers: [...low, ...detailNoBorders],
};
fs.writeFileSync(path.join(mapsDir, 'styles', 'india.json'), JSON.stringify(style));
console.log(`wrote ${style.layers.length} layers`);
