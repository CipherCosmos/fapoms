import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { CircuitBreaker } from '../../infrastructure/resilience/circuit-breaker';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { calculateHaversineDistance, TravelMode } from '@fapoms/shared';

/**
 * FAPOMS — road distance and travel time between two points.
 *
 * ## Why this is not "haversine ÷ 40 km/h"
 *
 * Until August 2026 every distance the planner scored, every travel allowance the offer engine
 * quoted and every "km away" the operator saw was the great-circle distance, and every travel
 * time was that distance at an assumed 40 km/h. Both were wrong, in opposite directions.
 * Measured against OSRM on seven real (branch, assayer) pairs from this database on 2026-08-17:
 *
 *   pair                                   straight  assumed | road km  road min | km×   min×
 *   JALAKANDAPURAM ← Rajeshkumar K            63.7 km   96 min |  84.6      70   | 1.33   0.73
 *   KOZHINJAPPARA ← P Pravesh                269.6 km  404 min | 373.4     310   | 1.38   0.77
 *   CHAKAN ← Deepak Kesharmal Varma           30.3 km   45 min |  36.3      33   | 1.20   0.73
 *   PAMPANAR (Idukki) ← Ramesh Kumar         176.3 km  264 min | 275.2     276   | 1.56   1.04
 *   HUBLI ← Belekar Satish Shankarrao        178.0 km  267 min | 206.9     159   | 1.16   0.60
 *   PUNE CAMP ← Bharamu Jayvant Bindage      205.9 km  309 min | 249.2     178   | 1.21   0.58
 *   NAWALGARH ← Leela Krishna Soni            28.3 km   43 min |  31.5      34   | 1.11   0.79
 *
 * The straight line under-states the road by 11–56 % (the Idukki hill pair is the worst), and
 * 40 km/h over-states the time by up to 70 % on the highway pairs while being about right in the
 * hills. No single detour factor or speed fixes both, because the error is a property of the
 * terrain between the two points — which is exactly what a road router knows and a formula does
 * not. So the primary path asks OSRM, and the formula survives only as a labelled fallback.
 *
 * ## The four things that make relying on a public router acceptable
 *
 * The default `OSRM_URL` is the OSRM project's demo server, https://router.project-osrm.org.
 * It has **no SLA**: the project describes it as a demo, it may rate-limit or vanish, and it
 * serves a car-only graph (see `osrmProfile`). Depending on it would be reckless without:
 *
 *   1. **Batching** — one `/table` request routes a branch against the whole candidate pool
 *      (measured: 100 coordinates across India in ~1 s), instead of one `/route` per candidate.
 *   2. **A cache** — roads between two fixed points do not change, so every routed pair is kept
 *      in Redis for 30 days under (origin, destination, profile). The public server sees each
 *      pair once; the second identical recommendation makes zero routing calls.
 *   3. **A circuit breaker and a hard timeout** — a dead or slow router costs one timeout, then
 *      the breaker opens and planning stops paying for it at all during the cooldown.
 *   4. **An honest fallback** — when the router is unavailable the old great-circle estimate is
 *      returned, but every result carries `source: 'OSRM' | 'ESTIMATE'` so nothing downstream
 *      can present "~164 km" as a road figure when it is a straight line.
 *
 * The upgrade path is self-hosting: `osrm/osrm-backend` in Docker with the India extract from
 * Geofabrik (a one-off extract/contract that wants a large-memory box for a country this size,
 * then a few GB to serve), and `OSRM_URL` pointed at it. Nothing here changes; the profile
 * mapping below then also becomes real if one router per profile is run behind a path-based
 * proxy. New environment knobs, all optional: `OSRM_URL`, `OSRM_TIMEOUT_MS` (4000),
 * `OSRM_CACHE_TTL_S` (30 days), `OSRM_TABLE_MAX_COORDS` (100), `OSRM_BREAKER_THRESHOLD` (5),
 * `OSRM_BREAKER_COOLDOWN_MS` (30000), `ROUTING_PROVIDER` (OSRM | POSTGIS).
 *
 * FOSSGIS's https://routing.openstreetmap.de does serve separate car/bike/foot graphs, but its
 * usage policy limits it to OpenStreetMap-related use, so it is not a default here.
 */

export type RoutingMode = 'driving' | 'walking' | 'cycling';

/**
 * Where a route's figures came from. Every consumer that shows a distance or a time to a person
 * must be able to tell these apart:
 *   - `OSRM`     — road network. "212 km by road, about 2 h 45 min."
 *   - `ESTIMATE` — great-circle distance and an assumed speed. "~164 km (straight line, estimate)."
 * A cached OSRM answer is still `OSRM`; estimates are never cached.
 */
export type RouteSource = 'OSRM' | 'ESTIMATE';

export interface RouteResult {
  distanceKm: number;
  durationMinutes: number;
  source: RouteSource;
}

export interface DestinationCoords {
  id: string;
  latitude: number;
  longitude: number;
}

export interface OptimizedRoute {
  optimizedSequence: string[];
  totalDistanceKm: number;
  totalDurationMinutes: number;
  steps: { destinationId: string; distanceKm: number; durationMinutes: number; source: RouteSource }[];
  /** `OSRM` only if every leg travelled was routed; one estimated leg makes the whole plan an estimate. */
  source: RouteSource;
}

export interface RoutingProvider {
  calculateRoute(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
    mode?: RoutingMode,
  ): Promise<RouteResult>;

  calculateDistances(
    origin: { latitude: number; longitude: number },
    destinations: DestinationCoords[],
    mode?: RoutingMode,
  ): Promise<Record<string, RouteResult>>;

  optimizeRoute(
    origin: { latitude: number; longitude: number },
    destinations: DestinationCoords[],
    roundTrip?: boolean,
    mode?: RoutingMode,
  ): Promise<OptimizedRoute>;
}

/**
 * Which routing profile a way of travelling should be priced and timed against.
 *
 * OSRM ships three profiles: car, bicycle and foot. Nothing in the rate card is a bicycle, and
 * that is the trap this function exists to name: `TWO_WHEELER` means a motorbike or scooter,
 * which uses the same roads at the same speeds as a car (faster, if anything, in city traffic —
 * lane-splitting is not something a router models). Routing it on the *bicycle* profile would
 * choose cycle-friendly back roads and report ~15 km/h, so a 40 km ride would be quoted at
 * two and a half hours. It therefore takes the driving profile's distance and duration, and no
 * separate two-wheeler speed is invented anywhere.
 *
 * Every other mode also resolves to `driving`, for different reasons:
 *   - CAR, TAXI, AUTO_RICKSHAW: they are cars, as far as a road graph is concerned.
 *   - BUS: uses the same roads. The car duration under-states a bus with stops; the distance is
 *     right, and distance is what the per-km rate card multiplies.
 *   - TRAIN, FLIGHT: a road router knows nothing about rail or air. The driving figures are the
 *     road-access proxy the rate card has always used, and the caller must not present the
 *     duration as the journey time for these modes.
 *   - OTHER: no special handling anywhere, by design (see the enum).
 *
 * `walking` and `cycling` remain reachable through the API for the day planner's on-foot legs;
 * no `TravelMode` maps to them.
 */
export const ROUTING_MODE_BY_TRAVEL_MODE: Record<TravelMode, RoutingMode> = {
  [TravelMode.CAR]: 'driving',
  [TravelMode.TAXI]: 'driving',
  [TravelMode.AUTO_RICKSHAW]: 'driving',
  // A motorbike, not a bicycle — see above. Never 'cycling'.
  [TravelMode.TWO_WHEELER]: 'driving',
  [TravelMode.BUS]: 'driving',
  [TravelMode.TRAIN]: 'driving',
  [TravelMode.FLIGHT]: 'driving',
  [TravelMode.OTHER]: 'driving',
};

export function routingModeForTravelMode(mode: TravelMode | null | undefined): RoutingMode {
  return (mode && ROUTING_MODE_BY_TRAVEL_MODE[mode]) || 'driving';
}

/**
 * Coordinates as they appear in a cache key and in a request URL: four decimal places, which
 * is 11 m of latitude and ≤ 11 m of longitude in India. That is below the accuracy tier of every
 * automated geocode (`PRECISION_METERS` in osm-geocoder.ts starts at 10 m for an OSM POI and is
 * 60 m for a geocoder hit) and about the accuracy of a manual pin, so two points that round to
 * the same cell are, for routing, the same point. Rounding the request as well as the key means a
 * cache entry describes exactly the coordinates that were routed, and it halves URL length —
 * which matters, because the public server's `/table` limit is nginx's 8 KB URI, not a
 * coordinate count (measured 2026-08-17: 400 coordinates OK, 500 → HTTP 414).
 */
function coordKey(lat: number, lng: number): string {
  return `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
}

/** The same rounding, as an OSRM URL fragment (`lng,lat`). */
function coordUrl(lat: number, lng: number): string {
  return `${Number(lng).toFixed(4)},${Number(lat).toFixed(4)}`;
}

/**
 * Great-circle distance and an implied duration — the ESTIMATE.
 *
 * `calculateHaversineDistance` from @fapoms/shared is the platform's one distance function —
 * the geofence, the check-in record and the mobile app already measure with it. It differs from
 * PostGIS's ST_DistanceSphere only in Earth radius (6371 vs 6371.008), which is 0.3 m over
 * 233 km. This used to be sent to Postgres as arithmetic over a pooled connection; it is a pure
 * function and runs in-process.
 *
 * The speeds are assumptions, and are labelled as such by `source: 'ESTIMATE'`. 40 km/h for a
 * car is a straight-line speed, not a road speed — over the seven pairs at the top of this file
 * it over-states journey time by 25–40 % on highways and matches within 5 % in the Idukki
 * hills, i.e. it is a middling guess whose error you cannot know without a road router. It is
 * kept unchanged so a fallback figure is at least the same fallback figure it always was;
 * improving it would mean pretending to know what only OSRM knows.
 */
export function estimateRoute(
  origin: { latitude: number; longitude: number },
  destination: { latitude: number; longitude: number },
  mode?: RoutingMode,
): RouteResult {
  const distanceKm = calculateHaversineDistance(
    origin.latitude,
    origin.longitude,
    destination.latitude,
    destination.longitude,
  );
  const assumedSpeedKmh = mode === 'walking' ? 5 : mode === 'cycling' ? 15 : 40;
  const durationMinutes = (distanceKm / assumedSpeedKmh) * 60;
  return {
    distanceKm: parseFloat(distanceKm.toFixed(2)),
    durationMinutes: parseFloat(durationMinutes.toFixed(2)),
    source: 'ESTIMATE',
  };
}

@Injectable()
export class PostGISRoutingProvider implements RoutingProvider {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * See `estimateRoute`. Kept as a provider so `ROUTING_PROVIDER=POSTGIS` still selects it
   * outright (e.g. an air-gapped deployment), and so the OSRM provider has something to fall
   * back to that carries the honest label.
   */
  async calculateRoute(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
    mode?: RoutingMode,
  ): Promise<RouteResult> {
    return estimateRoute(origin, destination, mode);
  }

  async calculateDistances(
    origin: { latitude: number; longitude: number },
    destinations: DestinationCoords[],
    mode?: RoutingMode,
  ): Promise<Record<string, RouteResult>> {
    // In-process, so this loop is arithmetic rather than one round trip per destination.
    const results: Record<string, RouteResult> = {};
    for (const dest of destinations) {
      results[dest.id] = estimateRoute(origin, dest, mode);
    }
    return results;
  }

  async optimizeRoute(
    origin: { latitude: number; longitude: number },
    destinations: DestinationCoords[],
    roundTrip = false,
    mode?: RoutingMode,
  ): Promise<OptimizedRoute> {
    const matrix: Record<string, Record<string, RouteResult>> = {};
    const allNodes = [
      { id: 'origin', latitude: origin.latitude, longitude: origin.longitude },
      ...destinations,
    ];

    for (const fromNode of allNodes) {
      matrix[fromNode.id] = {};
      for (const toNode of allNodes) {
        if (fromNode.id === toNode.id) {
          matrix[fromNode.id][toNode.id] = { distanceKm: 0, durationMinutes: 0, source: 'ESTIMATE' };
        } else {
          matrix[fromNode.id][toNode.id] = estimateRoute(fromNode, toNode, mode);
        }
      }
    }

    return solveTSP(origin, destinations, matrix, roundTrip);
  }
}

/** The router answered, with a status that is not success. Distinguished so it is never retried. */
class OsrmHttpError extends Error {
  constructor(readonly status: number) {
    super(`OSRM HTTP ${status}${status === 429 ? ' (rate limited)' : ''}`);
    this.name = 'OsrmHttpError';
  }
}

/** Counters a test or an operator can read to see what the provider actually did. */
export interface OsrmRoutingStats {
  /** HTTP requests sent to the OSRM server (route or table). */
  requests: number;
  /** Pairs answered from Redis without a request. */
  cacheHits: number;
  /** Pairs that had to be routed (or estimated) because they were not cached. */
  cacheMisses: number;
  /** Pairs answered with a great-circle estimate because OSRM could not answer. */
  estimates: number;
}

@Injectable()
export class OSRMRoutingProvider implements RoutingProvider {
  private readonly logger = new Logger(OSRMRoutingProvider.name);
  private readonly baseUrl: string;
  private readonly cacheTtlSeconds: number;
  private readonly maxTableCoords: number;

  readonly stats: OsrmRoutingStats = { requests: 0, cacheHits: 0, cacheMisses: 0, estimates: 0 };

  // Trips after repeated OSRM failures and skips the call (straight to the estimate) during the
  // cooldown, so a sustained routing outage doesn't make every planning request pay the fetch
  // timeout first.
  private readonly breaker = new CircuitBreaker({
    name: 'osrm',
    failureThreshold: Number(process.env.OSRM_BREAKER_THRESHOLD) || 5,
    cooldownMs: Number(process.env.OSRM_BREAKER_COOLDOWN_MS) || 30_000,
  });

  constructor(
    private readonly configService: ConfigService,
    private readonly postGISProvider: PostGISRoutingProvider,
    /**
     * Optional so the provider still constructs where the global CacheModule is not wired
     * (unit tests). Absent or Redis-less it behaves as an always-miss cache, which is exactly
     * how CacheService itself degrades.
     */
    @Optional() private readonly cache?: CacheService,
  ) {
    this.baseUrl = String(
      this.configService.get<string>('OSRM_URL') || 'https://router.project-osrm.org',
    ).replace(/\/+$/, '');
    /**
     * 30 days. Roads between two fixed points do not move; a new bypass or a closed bridge
     * changes a figure by a few percent, and thirty days bounds how long that can go unseen.
     * The cost of a longer TTL is nothing; the cost of a shorter one is traffic to a server we
     * are asked to be gentle with.
     */
    this.cacheTtlSeconds = Number(this.configService.get('OSRM_CACHE_TTL_S')) || 30 * 24 * 3600;
    /**
     * Coordinates per `/table` request, origin included. 100 is `osrm-routed`'s own default
     * `--max-table-size`, so a self-hosted router accepts it out of the box, and at four
     * decimals it is a ~2 KB URL, a quarter of the public server's nginx limit.
     */
    this.maxTableCoords = Math.max(2, Number(this.configService.get('OSRM_TABLE_MAX_COORDS')) || 100);
  }

  /**
   * The URL profile segment for a mode.
   *
   * These are the names OSRM's shipped profiles are conventionally served under. **On the
   * public demo server they make no difference**: measured 2026-08-17, `driving`, `bike`,
   * `foot` — and even `nonsense` — all return the identical car route (1.344 km, 2.71 min for
   * a Pune street pair that would take a pedestrian ~16 min), because that deployment loads
   * one car graph and ignores the segment. The mapping is kept so a self-hosted router per
   * profile behind a path-routing proxy needs no code change, and so the cache key separates
   * profiles from day one. Until then, `walking` and `cycling` figures are car figures — and
   * they are cached as such, so the day a real foot/bike router is put behind `OSRM_URL`,
   * flush `geo:route:v1:foot:*` and `geo:route:v1:bike:*` (or the TTL will, within 30 days).
   */
  private osrmProfile(mode?: RoutingMode): string {
    return mode === 'walking' ? 'foot' : mode === 'cycling' ? 'bike' : 'driving';
  }

  /**
   * `geo:route:v1:<profile>:<origin lat,lng>><dest lat,lng>`, coordinates at 4 dp. Directional:
   * one-way systems make A→B and B→A different roads, and `/table` returns both anyway. The
   * `v1` is the key schema, not the data; bump it if the value shape changes.
   */
  private cacheKey(profile: string, originKey: string, destKey: string): string {
    return `geo:route:v1:${profile}:${originKey}>${destKey}`;
  }

  private async readCached(profile: string, originKey: string, destKey: string): Promise<RouteResult | null> {
    if (!this.cache) return null;
    const hit = await this.cache.getJson<RouteResult>(this.cacheKey(profile, originKey, destKey));
    // Only OSRM answers are ever written, but a defensive read costs nothing.
    return hit && hit.source === 'OSRM' ? hit : null;
  }

  private async writeCached(profile: string, originKey: string, destKey: string, result: RouteResult): Promise<void> {
    if (!this.cache || result.source !== 'OSRM') return;
    await this.cache.setJson(this.cacheKey(profile, originKey, destKey), result, this.cacheTtlSeconds);
  }

  /**
   * fetch() with a hard timeout and one fast retry.
   *
   * The timeout: without it, a stalled OSRM server holds the request open until the OS TCP
   * timeout (minutes) before the fallback can run — so a slow external routing service would
   * freeze planning. AbortController fails fast so the estimate kicks in quickly.
   *
   * The retry: from inside the backend container, connections to the public server fail in
   * bursts — measured 2026-08-17, 13 of 15 consecutive attempts failed with ETIMEDOUT after
   * ~265 ms in one window and 0 of 15 a few minutes later, against an unchanged server. That
   * ~265 ms is Node's happy-eyeballs attempt timeout (250 ms): the host has an A and an AAAA
   * record, the container has no IPv6 route, and when the SYN-ACK is later than 250 ms Node
   * abandons the IPv4 attempt, fails the IPv6 one instantly and reports ETIMEDOUT with a
   * healthy router on the other end. main.ts now raises that attempt timeout to 1000 ms, which
   * took the failure rate from 23/90 to 0/90 in alternated runs; the retry stays as the
   * belt to that brace, since a second attempt a moment later usually lands. So a *fast*
   * network failure is retried once; a timeout is not (that would double the wait for a
   * router that is genuinely slow), and an HTTP status is not (the server answered — a 429 in
   * particular must not be answered with another request). Each attempt counts as a request
   * in `stats`; only the final failure counts against the breaker.
   */
  private async fetchJson(url: string): Promise<any> {
    const timeoutMs = Number(process.env.OSRM_TIMEOUT_MS) || 4000;
    this.logger.debug(`OSRM GET ${url.length > 160 ? `${url.slice(0, 160)}… (${url.length} chars)` : url}`);
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      try {
        return await this.fetchOnce(url, timeoutMs);
      } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError';
        const answered = err instanceof OsrmHttpError;
        const fast = Date.now() - started < 1000;
        if (attempt === 1 && !aborted && !answered && fast) {
          this.logger.debug(`OSRM connect failed fast (${(err as Error).message}); retrying once.`);
          continue;
        }
        // The breaker swallows the error on the way to the estimate; without this line a router
        // that is refusing us (429), unreachable, or slow all look identical in the log.
        const reason = aborted ? `timed out after ${timeoutMs} ms` : err instanceof Error ? err.message : String(err);
        this.logger.warn(`OSRM request failed (${reason}) — falling back to great-circle estimate for this batch.`);
        throw err;
      }
    }
  }

  private async fetchOnce(url: string, timeoutMs: number): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    this.stats.requests += 1;
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent':
            process.env.GEOCODER_USER_AGENT ||
            'FAPOMS/1.0 (field-audit operations platform; contact: it@sumeruglobal.in)',
        },
      });
      if (!res.ok) throw new OsrmHttpError(res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private static fromOsrm(distanceMetres: number, durationSeconds: number): RouteResult {
    return {
      distanceKm: parseFloat((distanceMetres / 1000).toFixed(2)),
      durationMinutes: parseFloat((durationSeconds / 60).toFixed(2)),
      source: 'OSRM',
    };
  }

  private estimate(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
    mode?: RoutingMode,
  ): RouteResult {
    this.stats.estimates += 1;
    return estimateRoute(origin, destination, mode);
  }

  async calculateRoute(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
    mode?: RoutingMode,
  ): Promise<RouteResult> {
    const profile = this.osrmProfile(mode);
    const originKey = coordKey(origin.latitude, origin.longitude);
    const destKey = coordKey(destination.latitude, destination.longitude);

    const cached = await this.readCached(profile, originKey, destKey);
    if (cached) {
      this.stats.cacheHits += 1;
      return cached;
    }
    this.stats.cacheMisses += 1;

    const fallback = async () => this.estimate(origin, destination, mode);
    return this.breaker.run(async () => {
      const url =
        `${this.baseUrl}/route/v1/${profile}/` +
        `${coordUrl(origin.latitude, origin.longitude)};${coordUrl(destination.latitude, destination.longitude)}` +
        `?overview=false`;
      const data = await this.fetchJson(url);
      const route = data?.code === 'Ok' ? data.routes?.[0] : null;
      if (route && Number.isFinite(route.distance) && Number.isFinite(route.duration)) {
        const result = OSRMRoutingProvider.fromOsrm(route.distance, route.duration);
        // Physics check — same reasoning as the /table guard: a "road" shorter than the
        // straight line means the router snapped one end somewhere else entirely. Never trust
        // it, never cache it; the estimate is honest about being an estimate.
        const straightKm = calculateHaversineDistance(
          origin.latitude, origin.longitude, destination.latitude, destination.longitude,
        );
        if (result.distanceKm < straightKm * 0.99) {
          this.logger.warn(
            `routing[${profile}] /route answer for ${originKey}>${destKey} is impossible ` +
              `(road ${result.distanceKm} km < straight ${straightKm.toFixed(1)} km) — using the estimate`,
          );
          return fallback();
        }
        await this.writeCached(profile, originKey, destKey, result);
        return result;
      }
      // OSRM answered but had no usable route (e.g. a point it cannot snap to a road) — it is
      // up, so don't trip the breaker; estimate this one pair.
      return fallback();
    }, fallback);
  }

  /**
   * One origin against many destinations — the recommendation engine's shape.
   *
   * Three things keep the public server's view of this a trickle:
   *   - Every pair is looked up in the cache first; only misses are routed.
   *   - Destinations that share a coordinate are routed once. This is not a corner case: on
   *     this database assayers sit on city centroids and 40 of 82 branches share a pin (see
   *     geo-precision.service.ts), so a pool collapses to its distinct points — 27 assayers
   *     to 25 on the dev database, and far fewer once a real roster is imported by city.
   *   - The misses go in `/table` requests of at most `maxTableCoords` coordinates each
   *     (origin included), so a pool of any size costs ceil(unique/99) requests, not N.
   *     `/table` and `/route` agree exactly — measured on the seven pairs above, the two
   *     endpoints differ by 0.000 km and 0.000 min for every pair — so mixing cached `/route`
   *     answers with fresh `/table` answers is safe.
   *
   * A destination the router cannot reach (a null cell — an island, or a point far from any
   * road) is estimated individually and not cached, and does not trip the breaker: the server
   * answered. A whole request that fails (timeout, 5xx, breaker open) estimates that chunk.
   */
  async calculateDistances(
    origin: { latitude: number; longitude: number },
    destinations: DestinationCoords[],
    mode?: RoutingMode,
  ): Promise<Record<string, RouteResult>> {
    const results: Record<string, RouteResult> = {};
    if (destinations.length === 0) return results;

    const profile = this.osrmProfile(mode);
    const originKey = coordKey(origin.latitude, origin.longitude);

    // Group by rounded coordinate: one lookup per distinct point, fanned back out to every id.
    const byPoint = new Map<string, { latitude: number; longitude: number; ids: string[] }>();
    for (const d of destinations) {
      const key = coordKey(d.latitude, d.longitude);
      const entry = byPoint.get(key);
      if (entry) entry.ids.push(d.id);
      else byPoint.set(key, { latitude: d.latitude, longitude: d.longitude, ids: [d.id] });
    }

    const resolved = new Map<string, RouteResult>();
    const misses: string[] = [];
    await Promise.all(
      Array.from(byPoint.keys()).map(async (key) => {
        const cached = await this.readCached(profile, originKey, key);
        if (cached) resolved.set(key, cached);
        else misses.push(key);
      }),
    );
    const cachedCount = resolved.size;
    this.stats.cacheHits += cachedCount;
    this.stats.cacheMisses += misses.length;

    const perChunk = this.maxTableCoords - 1;
    const chunks: string[][] = [];
    for (let i = 0; i < misses.length; i += perChunk) chunks.push(misses.slice(i, i + perChunk));

    let estimated = 0;
    const requestsBefore = this.stats.requests;
    await Promise.all(
      chunks.map((chunk) => {
        const points = chunk.map((key) => byPoint.get(key)!);
        const fallback = async () => {
          for (let i = 0; i < chunk.length; i++) {
            resolved.set(chunk[i], this.estimate(origin, points[i], mode));
            estimated += 1;
          }
        };
        return this.breaker.run(async () => {
          const coords = [
            coordUrl(origin.latitude, origin.longitude),
            ...points.map((p) => coordUrl(p.latitude, p.longitude)),
          ].join(';');
          // `annotations=distance,duration` is required: without it `/table` returns durations
          // only, `distances` is absent, and every call used to fall through to the estimate.
          const url = `${this.baseUrl}/table/v1/${profile}/${coords}?sources=0&annotations=distance,duration`;
          const data = await this.fetchJson(url);
          const distances: Array<number | null> | undefined = data?.code === 'Ok' ? data.distances?.[0] : undefined;
          const durations: Array<number | null> | undefined = data?.code === 'Ok' ? data.durations?.[0] : undefined;
          if (!distances || !durations) return fallback();
          await Promise.all(
            chunk.map(async (key, i) => {
              const distance = distances[i + 1];
              const duration = durations[i + 1];
              if (typeof distance === 'number' && typeof duration === 'number') {
                const result = OSRMRoutingProvider.fromOsrm(distance, duration);
                /**
                 * Physics check: a road can never be shorter than the straight line.
                 *
                 * The public demo server mis-snaps coordinates in larger `/table` requests —
                 * measured 29 Aug 2026: the same point that snaps 19 m in a 2-coordinate table
                 * snapped 139 km away in a 14-coordinate one, deterministically, returning
                 * `code: Ok` — so a candidate 182 km away was shown (and nearly paid) as
                 * 155 km. An impossible cell is re-routed as its own single-pair request,
                 * which snaps correctly; the pair path has the same guard, so a second bad
                 * answer degrades to the labelled estimate rather than being trusted.
                 */
                const straightKm = calculateHaversineDistance(
                  origin.latitude, origin.longitude, points[i].latitude, points[i].longitude,
                );
                if (result.distanceKm < straightKm * 0.99) {
                  this.logger.warn(
                    `routing[${profile}] /table cell for ${key} is impossible ` +
                      `(road ${result.distanceKm} km < straight ${straightKm.toFixed(1)} km) — re-routing the pair individually`,
                  );
                  const single = await this.calculateRoute(
                    origin, { latitude: points[i].latitude, longitude: points[i].longitude }, mode,
                  ).catch(() => null);
                  resolved.set(key, single ?? this.estimate(origin, points[i], mode));
                  if (!single) estimated += 1;
                } else {
                  resolved.set(key, result);
                  await this.writeCached(profile, originKey, key, result);
                }
              } else {
                resolved.set(key, this.estimate(origin, points[i], mode));
                estimated += 1;
              }
            }),
          );
        }, fallback);
      }),
    );

    for (const [key, entry] of byPoint) {
      const result = resolved.get(key) ?? this.estimate(origin, entry, mode);
      for (const id of entry.ids) results[id] = result;
    }

    // One line per pool, so a log shows at a glance whether the cache is doing its job.
    this.logger.log(
      `routing[${profile}] ${destinations.length} pair(s), ${byPoint.size} distinct point(s): ` +
        `${cachedCount} cached, ${misses.length - estimated} via OSRM in ` +
        `${this.stats.requests - requestsBefore} request(s), ${estimated} estimated`,
    );
    return results;
  }

  /**
   * All-pairs matrix for the day planner. Small clusters (a day's branches) fit one `/table`
   * request; anything larger is built row by row through `calculateDistances`, which chunks
   * and caches. Either way every pair lands in the cache under the same key `calculateRoute`
   * reads, so a route the planner has seen is free for the offer that follows it.
   */
  async optimizeRoute(
    origin: { latitude: number; longitude: number },
    destinations: DestinationCoords[],
    roundTrip = false,
    mode?: RoutingMode,
  ): Promise<OptimizedRoute> {
    const profile = this.osrmProfile(mode);
    const allNodes: DestinationCoords[] = [
      { id: 'origin', latitude: origin.latitude, longitude: origin.longitude },
      ...destinations,
    ];
    const keyOf = new Map(allNodes.map((n) => [n.id, coordKey(n.latitude, n.longitude)] as const));

    const matrix: Record<string, Record<string, RouteResult>> = {};
    for (const n of allNodes) matrix[n.id] = { [n.id]: { distanceKm: 0, durationMinutes: 0, source: 'OSRM' } };

    // Cache first: a matrix the planner already routed today costs nothing.
    let missing = 0;
    await Promise.all(
      allNodes.flatMap((from) =>
        allNodes
          .filter((to) => to.id !== from.id)
          .map(async (to) => {
            const cached = await this.readCached(profile, keyOf.get(from.id)!, keyOf.get(to.id)!);
            if (cached) matrix[from.id][to.id] = cached;
            else missing += 1;
          }),
      ),
    );
    this.stats.cacheHits += allNodes.length * (allNodes.length - 1) - missing;
    this.stats.cacheMisses += missing;

    if (missing > 0 && allNodes.length <= this.maxTableCoords) {
      const fallback = async () => {
        for (const from of allNodes) {
          for (const to of allNodes) {
            if (from.id !== to.id && !matrix[from.id][to.id]) matrix[from.id][to.id] = this.estimate(from, to, mode);
          }
        }
      };
      await this.breaker.run(async () => {
        const coords = allNodes.map((n) => coordUrl(n.latitude, n.longitude)).join(';');
        const url = `${this.baseUrl}/table/v1/${profile}/${coords}?annotations=distance,duration`;
        const data = await this.fetchJson(url);
        if (data?.code !== 'Ok' || !data.distances || !data.durations) return fallback();
        await Promise.all(
          allNodes.flatMap((from, i) =>
            allNodes.map(async (to, j) => {
              if (from.id === to.id) return;
              const distance = data.distances[i]?.[j];
              const duration = data.durations[i]?.[j];
              if (typeof distance === 'number' && typeof duration === 'number') {
                const result = OSRMRoutingProvider.fromOsrm(distance, duration);
                matrix[from.id][to.id] = result;
                await this.writeCached(profile, keyOf.get(from.id)!, keyOf.get(to.id)!, result);
              } else {
                matrix[from.id][to.id] = this.estimate(from, to, mode);
              }
            }),
          ),
        );
      }, fallback);
    } else if (missing > 0) {
      for (const from of allNodes) {
        const others = allNodes.filter((to) => to.id !== from.id && !matrix[from.id][to.id]);
        const row = await this.calculateDistances(from, others, mode);
        for (const to of others) matrix[from.id][to.id] = row[to.id];
      }
    }

    return solveTSP(origin, destinations, matrix, roundTrip);
  }
}

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  private readonly activeProvider: RoutingProvider;
  readonly providerName: 'OSRM' | 'POSTGIS';

  constructor(
    private readonly configService: ConfigService,
    private readonly postGISProvider: PostGISRoutingProvider,
    private readonly osrmProvider: OSRMRoutingProvider,
  ) {
    /**
     * OSRM by default. Until August 2026 the default was POSTGIS — the estimate — which meant
     * every deployment that did not set `ROUTING_PROVIDER` scored, quoted and displayed
     * straight-line figures without saying so. With the cache, breaker and labelled fallback
     * in the OSRM provider, choosing it by default costs nothing when the router is unreachable
     * (the same estimate comes back, now labelled) and gives road figures when it is.
     * `POSTGIS` remains selectable for a deployment that must make no outbound calls.
     */
    const configured = String(this.configService.get<string>('ROUTING_PROVIDER') || 'OSRM').toUpperCase();
    if (configured !== 'OSRM' && configured !== 'POSTGIS') {
      // `.env.production.example` has shipped `ROUTING_PROVIDER=google` for some time, and no
      // such provider exists. Under the old default that silently meant "estimate everything";
      // it now means the road router, said out loud.
      this.logger.warn(`ROUTING_PROVIDER='${configured}' is not a known provider (OSRM | POSTGIS); using OSRM.`);
    }
    this.providerName = configured === 'POSTGIS' ? 'POSTGIS' : 'OSRM';
    this.activeProvider = this.providerName === 'OSRM' ? this.osrmProvider : this.postGISProvider;
    this.logger.log(
      this.providerName === 'OSRM'
        ? `routing provider: OSRM (${this.configService.get<string>('OSRM_URL', 'https://router.project-osrm.org')}), great-circle estimate on failure`
        : 'routing provider: POSTGIS — every distance is a great-circle ESTIMATE',
    );
  }

  async calculateRoute(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
    mode?: RoutingMode,
  ): Promise<RouteResult> {
    return this.activeProvider.calculateRoute(origin, destination, mode);
  }

  async calculateDistances(
    origin: { latitude: number; longitude: number },
    destinations: DestinationCoords[],
    mode?: RoutingMode,
  ): Promise<Record<string, RouteResult>> {
    return this.activeProvider.calculateDistances(origin, destinations, mode);
  }

  async optimizeRoute(
    origin: { latitude: number; longitude: number },
    destinations: DestinationCoords[],
    roundTrip = false,
    mode?: RoutingMode,
  ): Promise<OptimizedRoute> {
    return this.activeProvider.optimizeRoute(origin, destinations, roundTrip, mode);
  }
}

function solveTSP(
  origin: { latitude: number; longitude: number },
  destinations: DestinationCoords[],
  matrix: Record<string, Record<string, RouteResult>>,
  roundTrip = false,
): OptimizedRoute {
  const unvisited = new Set(destinations.map((d) => d.id));
  const sequence: string[] = [];
  const steps: OptimizedRoute['steps'] = [];

  let currentId = 'origin';
  let totalDistanceKm = 0;
  let totalDurationMinutes = 0;
  let source: RouteSource = 'OSRM';

  while (unvisited.size > 0) {
    let nearestId = '';
    let minDistance = Infinity;

    for (const id of unvisited) {
      const dist = matrix[currentId]?.[id]?.distanceKm ?? Infinity;
      if (dist < minDistance) {
        minDistance = dist;
        nearestId = id;
      }
    }

    if (!nearestId) {
      nearestId = Array.from(unvisited)[0];
      minDistance = 0;
    }

    unvisited.delete(nearestId);
    sequence.push(nearestId);

    const leg = matrix[currentId]?.[nearestId];
    const stepDist = leg?.distanceKm ?? 0;
    const stepDur = leg?.durationMinutes ?? 0;
    const stepSource: RouteSource = leg?.source ?? 'ESTIMATE';
    if (stepSource === 'ESTIMATE') source = 'ESTIMATE';

    steps.push({
      destinationId: nearestId,
      distanceKm: stepDist,
      durationMinutes: stepDur,
      source: stepSource,
    });

    totalDistanceKm += stepDist;
    totalDurationMinutes += stepDur;
    currentId = nearestId;
  }

  if (roundTrip) {
    const back = matrix[currentId]?.['origin'];
    totalDistanceKm += back?.distanceKm ?? 0;
    totalDurationMinutes += back?.durationMinutes ?? 0;
    if ((back?.source ?? 'ESTIMATE') === 'ESTIMATE') source = 'ESTIMATE';
  }

  return {
    optimizedSequence: sequence,
    totalDistanceKm: parseFloat(totalDistanceKm.toFixed(2)),
    totalDurationMinutes: parseFloat(totalDurationMinutes.toFixed(2)),
    steps,
    source,
  };
}
