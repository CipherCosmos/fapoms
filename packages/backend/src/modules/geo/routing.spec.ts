import { Test, TestingModule } from '@nestjs/testing';
import {
  PostGISRoutingProvider,
  OSRMRoutingProvider,
  RoutingService,
  estimateRoute,
  routingModeForTravelMode,
  ROUTING_MODE_BY_TRAVEL_MODE,
} from './routing.provider';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { TravelMode } from '@fapoms/shared';
import { distanceScore, travelTimeScore } from '../planning/recommendation.engine';

/**
 * A CacheService stand-in with the two methods the routing provider uses, backed by a Map, so
 * the tests can assert what was written and how many times the network was touched.
 */
class FakeCache {
  store = new Map<string, string>();
  async getJson<T>(key: string): Promise<T | null> {
    const raw = this.store.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }
  async setJson(key: string, value: unknown, _ttl: number): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }
}

/** Real coordinates from the dev database (branch PUNE CAMP and three assayers). */
const PUNE_CAMP = { latitude: 18.5204, longitude: 73.8567 };
const DEEPAK = { id: 'a-deepak', latitude: 18.4763146, longitude: 73.8227963 }; // Anand Nagar, Pune
const BHARAMU = { id: 'a-bharamu', latitude: 16.8290678, longitude: 74.6475119 }; // Miraj
const BELEKAR = { id: 'a-belekar', latitude: 16.6678616, longitude: 74.2120874 }; // Karvir

/** What router.project-osrm.org returned for PUNE CAMP → those three on 2026-08-17. */
const TABLE_ROW = {
  distances: [7684.5, 249250.1, 236130.7],
  durations: [500.4, 10694.4, 12267.0],
};

function tableResponse(distances: Array<number | null>, durations: Array<number | null>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      code: 'Ok',
      distances: [[0, ...distances]],
      durations: [[0, ...durations]],
    }),
  } as unknown as Response;
}

async function buildModule(config: Record<string, unknown>, cache?: FakeCache): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      RoutingService,
      PostGISRoutingProvider,
      OSRMRoutingProvider,
      { provide: DataSource, useValue: { query: jest.fn() } },
      {
        provide: ConfigService,
        useValue: { get: (key: string, def?: unknown) => (key in config ? config[key] : def) },
      },
      ...(cache ? [{ provide: CacheService, useValue: cache }] : []),
    ],
  }).compile();
}

describe('Geo Routing & Optimization', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    (global as any).fetch = realFetch;
    jest.clearAllMocks();
  });

  describe('PostGIS provider (the estimate)', () => {
    let postGISProvider: PostGISRoutingProvider;
    let mockDataSource: { query: jest.Mock };

    beforeEach(async () => {
      mockDataSource = { query: jest.fn() };
      const module = await Test.createTestingModule({
        providers: [PostGISRoutingProvider, { provide: DataSource, useValue: mockDataSource }],
      }).compile();
      postGISProvider = module.get(PostGISRoutingProvider);
    });

    it('should correctly solve TSP nearest-neighbor sequence', async () => {
      // Setup coordinates: Origin at (0, 0), Branch 1 at (0, 1), Branch 2 at (0, 2)
      // Expected nearest path: origin (0,0) -> Branch 1 (0,1) -> Branch 2 (0,2)
      const origin = { latitude: 0, longitude: 0 };
      const destinations = [
        { id: 'branch-2', latitude: 2, longitude: 0 },
        { id: 'branch-1', latitude: 1, longitude: 0 },
      ];

      // No mock: the provider computes great-circle distance in process rather than asking
      // Postgres for arithmetic, so this now exercises the real maths. One degree of latitude
      // is 111.19 km (R = 6371 km), and each leg is rounded to 2dp before being summed:
      // 111.19 + 111.19 = 222.38. The old expectation of 222.6 came from this test's own mock,
      // which invented 111.3 km per degree.
      const result = await postGISProvider.optimizeRoute(origin, destinations, false);

      expect(result.optimizedSequence).toEqual(['branch-1', 'branch-2']);
      expect(result.totalDistanceKm).toBe(222.38);
      expect(result.steps.length).toBe(2);
      // Everything from this provider is a great-circle estimate, and says so.
      expect(result.source).toBe('ESTIMATE');
      expect(result.steps.every((s) => s.source === 'ESTIMATE')).toBe(true);
      // And no database round trip was taken to work that out.
      expect(mockDataSource.query).not.toHaveBeenCalled();
    });

    it('should include return path to origin when roundTrip is enabled', async () => {
      const origin = { latitude: 0, longitude: 0 };
      const destinations = [{ id: 'branch-1', latitude: 0, longitude: 1 }];

      const result = await postGISProvider.optimizeRoute(origin, destinations, true);

      expect(result.optimizedSequence).toEqual(['branch-1']);
      // 111.19 out to branch-1 on the equator + 111.19 back to origin, each rounded to 2dp.
      expect(result.totalDistanceKm).toBe(222.38);
      expect(mockDataSource.query).not.toHaveBeenCalled();
    });

    it('labels every result ESTIMATE and keeps the historical assumed speeds', async () => {
      // Pune → Nashik: 164.4 km straight line. By road it is 212.6 km / 167 min (OSRM,
      // 2026-08-17). The estimate is kept exactly as it was — 40 km/h over the straight line —
      // so nothing that ever depended on it moves; what changes is that it now says so.
      const r = await postGISProvider.calculateRoute(
        { latitude: 18.5204, longitude: 73.8567 },
        { latitude: 19.9975, longitude: 73.7898 },
      );
      expect(r.source).toBe('ESTIMATE');
      expect(r.distanceKm).toBeCloseTo(164.4, 0);
      expect(r.durationMinutes).toBeCloseTo((164.4 / 40) * 60, 0);

      expect(estimateRoute({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }, 'walking').durationMinutes)
        .toBeCloseTo((111.19 / 5) * 60, 0);
      expect(estimateRoute({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }, 'cycling').durationMinutes)
        .toBeCloseTo((111.19 / 15) * 60, 0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('OSRM provider — batching with /table', () => {
    it('routes a whole pool in one /table request, with distances requested explicitly', async () => {
      const module = await buildModule({ OSRM_URL: 'http://osrm.test' });
      const osrm = module.get(OSRMRoutingProvider);
      fetchMock.mockResolvedValueOnce(tableResponse(TABLE_ROW.distances, TABLE_ROW.durations));

      const results = await osrm.calculateDistances(PUNE_CAMP, [DEEPAK, BHARAMU, BELEKAR]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url: string = fetchMock.mock.calls[0][0];
      expect(url.startsWith('http://osrm.test/table/v1/driving/')).toBe(true);
      // Origin first, then the three destinations, lng,lat and rounded to 4 dp.
      expect(url).toContain('/73.8567,18.5204;73.8228,18.4763;74.6475,16.8291;74.2121,16.6679?');
      expect(url).toContain('sources=0');
      // Without this, /table returns durations only and every distance used to fall back.
      expect(url).toContain('annotations=distance,duration');

      expect(results[DEEPAK.id]).toEqual({ distanceKm: 7.68, durationMinutes: 8.34, source: 'OSRM' });
      expect(results[BHARAMU.id]).toEqual({ distanceKm: 249.25, durationMinutes: 178.24, source: 'OSRM' });
      expect(results[BELEKAR.id]).toEqual({ distanceKm: 236.13, durationMinutes: 204.45, source: 'OSRM' });
      expect(osrm.stats).toEqual({ requests: 1, cacheHits: 0, cacheMisses: 3, estimates: 0 });
    });

    it('routes destinations that share a coordinate once and fans the answer out', async () => {
      // On this database most assayers sit on a city centroid, so identical points are the
      // norm, not the exception. Two ids at DEEPAK's point should cost one coordinate.
      const module = await buildModule({ OSRM_URL: 'http://osrm.test' });
      const osrm = module.get(OSRMRoutingProvider);
      fetchMock.mockResolvedValueOnce(tableResponse([7684.5, 249250.1], [500.4, 10694.4]));

      const twin = { ...DEEPAK, id: 'a-deepak-twin' };
      const results = await osrm.calculateDistances(PUNE_CAMP, [DEEPAK, twin, BHARAMU]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url: string = fetchMock.mock.calls[0][0];
      expect(url.split('/table/v1/driving/')[1].split('?')[0].split(';')).toHaveLength(3);
      expect(results[DEEPAK.id]).toEqual(results[twin.id]);
      expect(results[twin.id].distanceKm).toBe(7.68);
    });

    it('chunks a pool larger than the per-request coordinate cap', async () => {
      // Cap of 3 coordinates per request = origin + 2 destinations. Five distinct
      // destinations → 3 requests (2 + 2 + 1), never one request with all six coordinates.
      const module = await buildModule({ OSRM_URL: 'http://osrm.test', OSRM_TABLE_MAX_COORDS: '3' });
      const osrm = module.get(OSRMRoutingProvider);
      // 200 km cells: the destinations sit ~100 km straight-line from Pune Camp, and the
      // physics guard re-routes any cell shorter than the straight line — a mock that answers
      // 10 km would (correctly) be rejected as impossible.
      fetchMock.mockImplementation(async (url: string) => {
        const n = url.split('/table/v1/driving/')[1].split('?')[0].split(';').length - 1;
        return tableResponse(Array(n).fill(200000), Array(n).fill(600));
      });

      const dests = [1, 2, 3, 4, 5].map((i) => ({ id: `d${i}`, latitude: 18 + i * 0.01, longitude: 73 + i * 0.01 }));
      const results = await osrm.calculateDistances(PUNE_CAMP, dests);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      for (const call of fetchMock.mock.calls) {
        const coords = (call[0] as string).split('/table/v1/driving/')[1].split('?')[0].split(';');
        expect(coords.length).toBeLessThanOrEqual(3);
      }
      expect(Object.keys(results)).toHaveLength(5);
      expect(Object.values(results).every((r) => r.source === 'OSRM' && r.distanceKm === 200)).toBe(true);
    });

    it('estimates only the pair OSRM could not reach, and does not trip the breaker for it', async () => {
      const module = await buildModule({ OSRM_URL: 'http://osrm.test' });
      const osrm = module.get(OSRMRoutingProvider);
      // A null cell is OSRM's "no route" (an island, or a point it cannot snap to a road).
      fetchMock.mockResolvedValueOnce(tableResponse([7684.5, null], [500.4, null]));

      const results = await osrm.calculateDistances(PUNE_CAMP, [DEEPAK, BHARAMU]);

      expect(results[DEEPAK.id].source).toBe('OSRM');
      expect(results[BHARAMU.id].source).toBe('ESTIMATE');
      expect(results[BHARAMU.id].distanceKm).toBeCloseTo(205.9, 0); // straight line, not 249 by road
      expect(osrm.stats.estimates).toBe(1);
      expect((osrm as any).breaker.getState()).toBe('CLOSED');
    });

    it('uses the foot and bike profiles for walking and cycling', async () => {
      const module = await buildModule({ OSRM_URL: 'http://osrm.test' });
      const osrm = module.get(OSRMRoutingProvider);
      // 10 km — plausibly above DEEPAK's ~6 km straight line, so the physics guard passes it.
      fetchMock.mockResolvedValue(tableResponse([10000], [600]));

      await osrm.calculateDistances(PUNE_CAMP, [DEEPAK], 'walking');
      await osrm.calculateDistances(PUNE_CAMP, [DEEPAK], 'cycling');
      await osrm.calculateDistances(PUNE_CAMP, [DEEPAK], 'driving');
      await osrm.calculateDistances(PUNE_CAMP, [DEEPAK]);

      const profiles = fetchMock.mock.calls.map((c) => (c[0] as string).match(/\/table\/v1\/([a-z]+)\//)![1]);
      expect(profiles).toEqual(['foot', 'bike', 'driving', 'driving']);
    });
  });

  describe('OSRM provider — the route cache', () => {
    it('answers a repeated pool from Redis with zero OSRM requests', async () => {
      const cache = new FakeCache();
      const module = await buildModule({ OSRM_URL: 'http://osrm.test' }, cache);
      const osrm = module.get(OSRMRoutingProvider);
      fetchMock.mockResolvedValueOnce(tableResponse(TABLE_ROW.distances, TABLE_ROW.durations));

      const first = await osrm.calculateDistances(PUNE_CAMP, [DEEPAK, BHARAMU, BELEKAR]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(cache.store.size).toBe(3);
      // Keyed by profile and 4-dp coordinates, so a nearby-but-not-identical pin still hits.
      expect(Array.from(cache.store.keys()).sort()).toEqual([
        'geo:route:v1:driving:18.5204,73.8567>16.6679,74.2121',
        'geo:route:v1:driving:18.5204,73.8567>16.8291,74.6475',
        'geo:route:v1:driving:18.5204,73.8567>18.4763,73.8228',
      ]);

      const second = await osrm.calculateDistances(PUNE_CAMP, [DEEPAK, BHARAMU, BELEKAR]);
      expect(fetchMock).toHaveBeenCalledTimes(1); // still one — no new request
      expect(second).toEqual(first);
      expect(second[BHARAMU.id].source).toBe('OSRM'); // a cached road figure is still a road figure

      // A single-pair lookup for a pair the batch already routed is also free. This is what
      // makes the offer's follow-up `calculateRoute` for the chosen candidate cost nothing.
      const one = await osrm.calculateRoute(PUNE_CAMP, BHARAMU);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(one).toEqual(first[BHARAMU.id]);
      expect(osrm.stats).toEqual({ requests: 1, cacheHits: 4, cacheMisses: 3, estimates: 0 });
    });

    it('routes only the pairs the cache does not have', async () => {
      const cache = new FakeCache();
      const module = await buildModule({ OSRM_URL: 'http://osrm.test' }, cache);
      const osrm = module.get(OSRMRoutingProvider);
      fetchMock.mockResolvedValueOnce(tableResponse([7684.5], [500.4]));
      await osrm.calculateDistances(PUNE_CAMP, [DEEPAK]);

      fetchMock.mockResolvedValueOnce(tableResponse([249250.1, 236130.7], [10694.4, 12267.0]));
      const results = await osrm.calculateDistances(PUNE_CAMP, [DEEPAK, BHARAMU, BELEKAR]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const secondUrl: string = fetchMock.mock.calls[1][0];
      // Only the two misses travelled; DEEPAK's point is not in the second request.
      expect(secondUrl).not.toContain('73.8228,18.4763');
      expect(results[DEEPAK.id].distanceKm).toBe(7.68);
      expect(results[BHARAMU.id].distanceKm).toBe(249.25);
    });

    it('never caches an estimate', async () => {
      const cache = new FakeCache();
      const module = await buildModule({ OSRM_URL: 'http://osrm.test' }, cache);
      const osrm = module.get(OSRMRoutingProvider);
      // Both the attempt and its one fast retry fail.
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const results = await osrm.calculateDistances(PUNE_CAMP, [DEEPAK, BHARAMU]);
      expect(results[DEEPAK.id].source).toBe('ESTIMATE');
      expect(cache.store.size).toBe(0);

      // So the next attempt goes to the router again and, once it answers, the truth wins.
      fetchMock.mockResolvedValueOnce(tableResponse([7684.5, 249250.1], [500.4, 10694.4]));
      const again = await osrm.calculateDistances(PUNE_CAMP, [DEEPAK, BHARAMU]);
      expect(again[DEEPAK.id]).toEqual({ distanceKm: 7.68, durationMinutes: 8.34, source: 'OSRM' });
      expect(cache.store.size).toBe(2);
    });
  });

  describe('OSRM provider — honest fallback', () => {
    it('completes with ESTIMATE results and does not throw when the router is dead (real socket)', async () => {
      // No mock here: a real fetch to a port nothing listens on, so the whole path — timeout
      // wrapper, breaker, estimate — is exercised against a genuine connection failure.
      (global as any).fetch = realFetch;
      const module = await buildModule({ OSRM_URL: 'http://127.0.0.1:1' });
      const osrm = module.get(OSRMRoutingProvider);

      const results = await osrm.calculateDistances(PUNE_CAMP, [DEEPAK, BHARAMU, BELEKAR]);

      expect(Object.keys(results)).toHaveLength(3);
      for (const r of Object.values(results)) expect(r.source).toBe('ESTIMATE');
      expect(results[BHARAMU.id].distanceKm).toBeCloseTo(205.9, 0); // straight line
      expect(results[BHARAMU.id].durationMinutes).toBeCloseTo((205.9 / 40) * 60, 0);
      expect(osrm.stats.estimates).toBe(3);

      const single = await osrm.calculateRoute(PUNE_CAMP, DEEPAK);
      expect(single.source).toBe('ESTIMATE');
    });

    it('opens the breaker after repeated failures and then skips the network entirely', async () => {
      const module = await buildModule({ OSRM_URL: 'http://osrm.test' });
      const osrm = module.get(OSRMRoutingProvider);
      fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }));

      for (let i = 0; i < 5; i++) await osrm.calculateRoute(PUNE_CAMP, DEEPAK);
      // Each lookup made its attempt and one fast retry — ten sockets — but counted as five
      // failures against the breaker, which is now open.
      expect(fetchMock).toHaveBeenCalledTimes(10);
      expect((osrm as any).breaker.getState()).toBe('OPEN');

      const r = await osrm.calculateDistances(PUNE_CAMP, [DEEPAK, BHARAMU]);
      expect(fetchMock).toHaveBeenCalledTimes(10); // not called again while open
      expect(r[DEEPAK.id].source).toBe('ESTIMATE');
      expect(r[BHARAMU.id].source).toBe('ESTIMATE');
    });

    it('retries a fast connect failure once, and takes the road figure when the retry lands', async () => {
      // The signature measured from the container: 13 of 15 attempts failing with ETIMEDOUT
      // after ~265 ms in one window, none a few minutes later. One retry turns most of those
      // into road figures instead of estimates.
      const module = await buildModule({ OSRM_URL: 'http://osrm.test' });
      const osrm = module.get(OSRMRoutingProvider);
      fetchMock
        .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } }))
        .mockResolvedValueOnce(tableResponse([7684.5], [500.4]));

      const r = await osrm.calculateDistances(PUNE_CAMP, [DEEPAK]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(r[DEEPAK.id]).toEqual({ distanceKm: 7.68, durationMinutes: 8.34, source: 'OSRM' });
      expect(osrm.stats.requests).toBe(2);
      expect((osrm as any).breaker.getState()).toBe('CLOSED');
    });

    it('does not retry a timeout — a slow router must not cost twice the wait', async () => {
      const module = await buildModule({ OSRM_URL: 'http://osrm.test' });
      const osrm = module.get(OSRMRoutingProvider);
      fetchMock.mockRejectedValueOnce(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));

      const r = await osrm.calculateRoute(PUNE_CAMP, DEEPAK);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(r.source).toBe('ESTIMATE');
    });

    it('treats an HTTP error as a failure, estimates, and does not retry it', async () => {
      // 429 in particular: a rate-limited server must not be answered with a second request.
      const module = await buildModule({ OSRM_URL: 'http://osrm.test' });
      const osrm = module.get(OSRMRoutingProvider);
      fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });

      const r = await osrm.calculateRoute(PUNE_CAMP, DEEPAK);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(r.source).toBe('ESTIMATE');
    });
  });

  describe('OSRM provider — optimizeRoute', () => {
    it('builds the matrix from one all-pairs /table and labels the plan', async () => {
      const cache = new FakeCache();
      const module = await buildModule({ OSRM_URL: 'http://osrm.test' }, cache);
      const osrm = module.get(OSRMRoutingProvider);
      // Coordinates go origin, B, A (the order given below); symmetric 3×3 in metres/seconds:
      // origin→A 10 km, origin→B 30 km, A→B 15 km — so nearest-neighbour is A then B.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 'Ok',
          distances: [
            [0, 30000, 10000],
            [30000, 0, 15000],
            [10000, 15000, 0],
          ],
          durations: [
            [0, 1800, 600],
            [1800, 0, 900],
            [600, 900, 0],
          ],
        }),
      });

      const plan = await osrm.optimizeRoute(
        PUNE_CAMP,
        [
          { id: 'B', latitude: 18.6, longitude: 73.9 },
          { id: 'A', latitude: 18.55, longitude: 73.86 },
        ],
        true,
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0][0] as string)).toContain('annotations=distance,duration');
      expect(plan.optimizedSequence).toEqual(['A', 'B']);
      expect(plan.totalDistanceKm).toBe(10 + 15 + 30);
      expect(plan.totalDurationMinutes).toBe(10 + 15 + 30);
      expect(plan.source).toBe('OSRM');
      expect(plan.steps.map((s) => s.source)).toEqual(['OSRM', 'OSRM']);
      // Every ordered pair landed in the cache under the key calculateRoute reads.
      expect(cache.store.size).toBe(6);
      const again = await osrm.optimizeRoute(
        PUNE_CAMP,
        [
          { id: 'B', latitude: 18.6, longitude: 73.9 },
          { id: 'A', latitude: 18.55, longitude: 73.86 },
        ],
        true,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(again).toEqual(plan);
    });

    it('marks the whole plan an estimate if any leg had to be estimated', async () => {
      const module = await buildModule({ OSRM_URL: 'http://osrm.test' });
      const osrm = module.get(OSRMRoutingProvider);
      fetchMock.mockRejectedValue(new Error('down'));

      const plan = await osrm.optimizeRoute(PUNE_CAMP, [{ id: 'A', latitude: 18.55, longitude: 73.86 }]);
      expect(plan.source).toBe('ESTIMATE');
      expect(plan.steps[0].source).toBe('ESTIMATE');
    });
  });

  describe('RoutingService provider selection', () => {
    it('defaults to OSRM when ROUTING_PROVIDER is unset', async () => {
      const module = await buildModule({});
      const service = module.get(RoutingService);
      expect(service.providerName).toBe('OSRM');
    });

    it('still honours ROUTING_PROVIDER=POSTGIS', async () => {
      const module = await buildModule({ ROUTING_PROVIDER: 'postgis' });
      const service = module.get(RoutingService);
      expect(service.providerName).toBe('POSTGIS');
      const r = await service.calculateRoute(PUNE_CAMP, DEEPAK);
      expect(r.source).toBe('ESTIMATE');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('passes calculateDistances through to the active provider', async () => {
      const module = await buildModule({ OSRM_URL: 'http://osrm.test' });
      const service = module.get(RoutingService);
      fetchMock.mockResolvedValueOnce(tableResponse([7684.5], [500.4]));
      const r = await service.calculateDistances(PUNE_CAMP, [DEEPAK]);
      expect(r[DEEPAK.id]).toEqual({ distanceKm: 7.68, durationMinutes: 8.34, source: 'OSRM' });
    });
  });

  describe('travel mode → routing profile', () => {
    it('routes a two-wheeler as a car, never as a bicycle', () => {
      // OSRM's bike profile is a bicycle (~15 km/h on cycle-friendly roads). A motorbike uses
      // the car's roads at the car's speeds; mapping it to 'cycling' would quote a 40 km ride
      // at two and a half hours.
      expect(routingModeForTravelMode(TravelMode.TWO_WHEELER)).toBe('driving');
      expect(routingModeForTravelMode(TravelMode.CAR)).toBe('driving');
      expect(routingModeForTravelMode(TravelMode.TAXI)).toBe('driving');
      expect(routingModeForTravelMode(TravelMode.AUTO_RICKSHAW)).toBe('driving');
      expect(routingModeForTravelMode(null)).toBe('driving');
      expect(routingModeForTravelMode(undefined)).toBe('driving');
      // Every travel mode has an explicit entry, and none of them is a bicycle.
      for (const mode of Object.values(TravelMode)) {
        expect(ROUTING_MODE_BY_TRAVEL_MODE[mode]).toBeDefined();
        expect(ROUTING_MODE_BY_TRAVEL_MODE[mode]).not.toBe('cycling');
      }
    });
  });

  describe('planning score curves over a real road distance', () => {
    it('keeps discriminating past 500 km and stays within 0–100', () => {
      // The old `100 − km/5` tied every candidate from 500 km out at zero.
      expect(distanceScore(0)).toBe(100);
      expect(distanceScore(100)).toBeCloseTo(60.65, 1);
      expect(distanceScore(250)).toBeCloseTo(28.65, 1);
      expect(distanceScore(500)).toBeCloseTo(8.21, 1);
      expect(distanceScore(1000)).toBeCloseTo(0.67, 1);
      expect(distanceScore(500)).toBeGreaterThan(distanceScore(1250));
      expect(distanceScore(1250)).toBeGreaterThan(0);
      expect(distanceScore(1e6)).toBeGreaterThanOrEqual(0);
      expect(distanceScore(NaN)).toBe(0);
    });

    it('scores travel time on the same shape, scaled to ~72 km/h', () => {
      // 200 km at the measured ~72 km/h is ~167 min, rounded to a 170-min scale; the two curves
      // meet there by design so neither dimension double-counts an ordinary road.
      expect(travelTimeScore(0)).toBe(100);
      expect(travelTimeScore(170)).toBeCloseTo(distanceScore(200), 5);
      expect(Math.abs(travelTimeScore(167) - distanceScore(200))).toBeLessThan(1);
      expect(travelTimeScore(600)).toBeGreaterThan(travelTimeScore(900));
      expect(travelTimeScore(900)).toBeGreaterThan(0);
      expect(travelTimeScore(60)).toBeCloseTo(70.3, 0);
    });
  });
});
