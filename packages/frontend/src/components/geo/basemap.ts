/**
 * Where every map in the web app gets its pictures from. The ONE definition — three map components
 * had each hard-coded OpenStreetMap's public tile server.
 *
 * Street map: our own India map, through the backend's cached `/geo/tiles` route (see the backend's
 * tile-proxy.service.ts and deploy/maps/). OpenStreetMap's standard tiles draw India's borders as
 * administered on the ground — the Line of Control, Aksai Chin outside India — which is not the
 * boundary the Survey of India publishes and not something an application in India may show. The
 * India map draws every international border from India's point of view. Same origin, so it also
 * satisfies the `img-src 'self'` content-security policy.
 *
 * Satellite: Esri World Imagery — photographs only, no border or label layer drawn on top.
 */
export const STREET_TILE_URL = '/api/v1/geo/tiles/{z}/{x}/{y}';

/** ODbL requires the OpenStreetMap credit wherever its data is shown; Protomaps and Natural Earth are the map's other sources. */
export const STREET_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
  + ' &middot; <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a>'
  + ' &middot; Natural Earth';

export const SATELLITE_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

export const SATELLITE_ATTRIBUTION = '&copy; Esri, Maxar, Earthstar Geographics';

/** The zooms the tile route serves (the backend's MIN_ZOOM/MAX_ZOOM). */
export const STREET_TILE_OPTIONS = { minZoom: 2, maxZoom: 19, attribution: STREET_ATTRIBUTION } as const;
export const SATELLITE_TILE_OPTIONS = { maxZoom: 19, attribution: SATELLITE_ATTRIBUTION } as const;
