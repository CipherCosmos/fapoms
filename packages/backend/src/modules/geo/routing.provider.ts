import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { CircuitBreaker } from '../../infrastructure/resilience/circuit-breaker';
import { calculateHaversineDistance } from '@fapoms/shared';

export type RoutingMode = 'driving' | 'walking' | 'cycling';

export interface RouteResult {
  distanceKm: number;
  durationMinutes: number;
}

export interface DestinationCoords {
  id: string;
  latitude: number;
  longitude: number;
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
  ): Promise<{
    optimizedSequence: string[];
    totalDistanceKm: number;
    totalDurationMinutes: number;
    steps: { destinationId: string; distanceKm: number; durationMinutes: number }[];
  }>;
}

@Injectable()
export class PostGISRoutingProvider implements RoutingProvider {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  private modeSpeed(mode?: RoutingMode): number {
    return mode === 'walking' ? 5 : mode === 'cycling' ? 15 : 40;
  }

  /**
   * Great-circle distance and an implied duration.
   *
   * This used to ask Postgres — `SELECT ST_DistanceSphere(ST_MakePoint(...), ST_MakePoint(...))`
   * — which touches no table at all: a pure trigonometric calculation sent over a socket, taken
   * from the connection pool, and sent back. That is invisible for one call and ruinous for the
   * pattern that actually uses it: the recommendation engine routes every candidate in the pool
   * (hundreds), and the day planner builds a full distance matrix per assayer per cluster, so
   * thousands of round trips competed for twenty pooled connections to compute arithmetic.
   *
   * `calculateHaversineDistance` from @fapoms/shared is the platform's one distance function —
   * the geofence, the check-in record and the mobile app already measure with it. It differs
   * from ST_DistanceSphere only in Earth radius (6371 vs PostGIS's 6371.008), which is 0.3 m
   * over 233 km — a thousand times finer than the rounding this method already applies, and far
   * below the accuracy of a geocoded branch address.
   */
  async calculateRoute(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
    mode?: RoutingMode,
  ): Promise<RouteResult> {
    const distanceKm = calculateHaversineDistance(
      origin.latitude,
      origin.longitude,
      destination.latitude,
      destination.longitude,
    );
    const speed = this.modeSpeed(mode);
    const durationMinutes = (distanceKm / speed) * 60;
    return {
      distanceKm: parseFloat(distanceKm.toFixed(2)),
      durationMinutes: parseFloat(durationMinutes.toFixed(2)),
    };
  }

  async calculateDistances(
    origin: { latitude: number; longitude: number },
    destinations: DestinationCoords[],
    mode?: RoutingMode,
  ): Promise<Record<string, RouteResult>> {
    // In-process now, so this loop is arithmetic rather than one round trip per destination.
    const results: Record<string, RouteResult> = {};
    for (const dest of destinations) {
      results[dest.id] = await this.calculateRoute(origin, dest, mode);
    }
    return results;
  }

  async optimizeRoute(
    origin: { latitude: number; longitude: number },
    destinations: DestinationCoords[],
    roundTrip = false,
    mode?: RoutingMode,
  ): Promise<{
    optimizedSequence: string[];
    totalDistanceKm: number;
    totalDurationMinutes: number;
    steps: { destinationId: string; distanceKm: number; durationMinutes: number }[];
  }> {
    const matrix: Record<string, Record<string, RouteResult>> = {};
    const allNodes = [
      { id: 'origin', latitude: origin.latitude, longitude: origin.longitude },
      ...destinations,
    ];

    for (const fromNode of allNodes) {
      matrix[fromNode.id] = {};
      for (const toNode of allNodes) {
        if (fromNode.id === toNode.id) {
          matrix[fromNode.id][toNode.id] = { distanceKm: 0, durationMinutes: 0 };
        } else {
          matrix[fromNode.id][toNode.id] = await this.calculateRoute(fromNode, toNode);
        }
      }
    }

    return solveTSP(origin, destinations, matrix, roundTrip);
  }
}

@Injectable()
export class OSRMRoutingProvider implements RoutingProvider {
  private readonly baseUrl: string;
  // Trips after repeated OSRM failures and skips the call (straight to PostGIS) during the cooldown, so
  // a sustained routing outage doesn't make every planning request pay the fetch timeout first.
  private readonly breaker = new CircuitBreaker({
    name: 'osrm',
    failureThreshold: Number(process.env.OSRM_BREAKER_THRESHOLD) || 5,
    cooldownMs: Number(process.env.OSRM_BREAKER_COOLDOWN_MS) || 30_000,
  });

  constructor(
    private readonly configService: ConfigService,
    private readonly postGISProvider: PostGISRoutingProvider,
  ) {
    this.baseUrl = this.configService.get<string>(
      'OSRM_URL',
      'https://router.project-osrm.org',
    );
  }

  private osrmProfile(mode?: RoutingMode): string {
    return mode === 'walking' ? 'foot' : mode === 'cycling' ? 'cycling' : 'driving';
  }

  /**
   * fetch() with a hard timeout. Without it, a stalled OSRM server holds the request open until the
   * OS TCP timeout (minutes) before the try/catch can fall back to PostGIS — so a slow external routing
   * service would freeze planning. AbortController fails fast so the PostGIS fallback kicks in quickly.
   */
  private async fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const timeoutMs = Number(process.env.OSRM_TIMEOUT_MS) || 4000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async calculateRoute(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
    mode?: RoutingMode,
  ): Promise<RouteResult> {
    const fallback = () => this.postGISProvider.calculateRoute(origin, destination, mode);
    return this.breaker.run(async () => {
      const profile = this.osrmProfile(mode);
      const url = `${this.baseUrl}/route/v1/${profile}/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}?overview=false`;
      const res = await this.fetchWithTimeout(url);
      if (!res.ok) throw new Error(`OSRM HTTP error: ${res.status}`);
      const data = await res.json();
      if (data.code === 'Ok' && data.routes?.[0]) {
        const route = data.routes[0];
        return {
          distanceKm: parseFloat((route.distance / 1000).toFixed(2)),
          durationMinutes: parseFloat((route.duration / 60).toFixed(2)),
        };
      }
      // OSRM answered but had no usable route — it's up, so don't trip the breaker; use PostGIS.
      return fallback();
    }, fallback);
  }

  async calculateDistances(
    origin: { latitude: number; longitude: number },
    destinations: DestinationCoords[],
    mode?: RoutingMode,
  ): Promise<Record<string, RouteResult>> {
    const fallback = () => this.postGISProvider.calculateDistances(origin, destinations, mode);
    return this.breaker.run(async () => {
      const profile = this.osrmProfile(mode);
      const coords = [
        `${origin.longitude},${origin.latitude}`,
        ...destinations.map((d) => `${d.longitude},${d.latitude}`),
      ].join(';');
      const url = `${this.baseUrl}/table/v1/${profile}/${coords}?sources=0`;
      const res = await this.fetchWithTimeout(url);
      if (!res.ok) throw new Error(`OSRM HTTP error: ${res.status}`);
      const data = await res.json();
      if (data.code === 'Ok' && data.durations?.[0] && data.distances?.[0]) {
        const results: Record<string, RouteResult> = {};
        destinations.forEach((dest, idx) => {
          const distance = data.distances[0][idx + 1];
          const duration = data.durations[0][idx + 1];
          results[dest.id] = {
            distanceKm: parseFloat((distance / 1000).toFixed(2)),
            durationMinutes: parseFloat((duration / 60).toFixed(2)),
          };
        });
        return results;
      }
      return fallback();
    }, fallback);
  }

  async optimizeRoute(
    origin: { latitude: number; longitude: number },
    destinations: DestinationCoords[],
    roundTrip = false,
    mode?: RoutingMode,
  ): Promise<{
    optimizedSequence: string[];
    totalDistanceKm: number;
    totalDurationMinutes: number;
    steps: { destinationId: string; distanceKm: number; durationMinutes: number }[];
  }> {
    const fallback = () => this.postGISProvider.optimizeRoute(origin, destinations, roundTrip, mode);
    return this.breaker.run(async () => {
      const profile = this.osrmProfile(mode);
      const coords = [
        `${origin.longitude},${origin.latitude}`,
        ...destinations.map((d) => `${d.longitude},${d.latitude}`),
      ].join(';');
      const url = `${this.baseUrl}/table/v1/${profile}/${coords}?annotations=distance,duration`;
      const res = await this.fetchWithTimeout(url);
      if (!res.ok) throw new Error(`OSRM HTTP error: ${res.status}`);
      const data = await res.json();
      if (data.code === 'Ok' && data.durations && data.distances) {
        const matrix: Record<string, Record<string, RouteResult>> = {};
        const allKeys = ['origin', ...destinations.map((d) => d.id)];

        allKeys.forEach((keyFrom, idxFrom) => {
          matrix[keyFrom] = {};
          allKeys.forEach((keyTo, idxTo) => {
            const distance = data.distances[idxFrom][idxTo];
            const duration = data.durations[idxFrom][idxTo];
            matrix[keyFrom][keyTo] = {
              distanceKm: parseFloat((distance / 1000).toFixed(2)),
              durationMinutes: parseFloat((duration / 60).toFixed(2)),
            };
          });
        });

        return solveTSP(origin, destinations, matrix, roundTrip);
      }
      return fallback();
    }, fallback);
  }
}

@Injectable()
export class RoutingService {
  private activeProvider: RoutingProvider;

  constructor(
    private readonly configService: ConfigService,
    private readonly postGISProvider: PostGISRoutingProvider,
    private readonly osrmProvider: OSRMRoutingProvider,
  ) {
    const providerName = this.configService.get<string>('ROUTING_PROVIDER', 'POSTGIS');
    this.activeProvider =
      providerName.toUpperCase() === 'OSRM' ? this.osrmProvider : this.postGISProvider;
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
  ): Promise<{
    optimizedSequence: string[];
    totalDistanceKm: number;
    totalDurationMinutes: number;
    steps: { destinationId: string; distanceKm: number; durationMinutes: number }[];
  }> {
    return this.activeProvider.optimizeRoute(origin, destinations, roundTrip, mode);
  }
}

function solveTSP(
  origin: { latitude: number; longitude: number },
  destinations: DestinationCoords[],
  matrix: Record<string, Record<string, RouteResult>>,
  roundTrip = false,
) {
  const unvisited = new Set(destinations.map((d) => d.id));
  const sequence: string[] = [];
  const steps: { destinationId: string; distanceKm: number; durationMinutes: number }[] = [];

  let currentId = 'origin';
  let totalDistanceKm = 0;
  let totalDurationMinutes = 0;

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

    const stepDist = matrix[currentId]?.[nearestId]?.distanceKm ?? 0;
    const stepDur = matrix[currentId]?.[nearestId]?.durationMinutes ?? 0;

    steps.push({
      destinationId: nearestId,
      distanceKm: stepDist,
      durationMinutes: stepDur,
    });

    totalDistanceKm += stepDist;
    totalDurationMinutes += stepDur;
    currentId = nearestId;
  }

  if (roundTrip) {
    const returnDist = matrix[currentId]?.[ 'origin' ]?.distanceKm ?? 0;
    const returnDur = matrix[currentId]?.[ 'origin' ]?.durationMinutes ?? 0;
    totalDistanceKm += returnDist;
    totalDurationMinutes += returnDur;
  }

  return {
    optimizedSequence: sequence,
    totalDistanceKm: parseFloat(totalDistanceKm.toFixed(2)),
    totalDurationMinutes: parseFloat(totalDurationMinutes.toFixed(2)),
    steps,
  };
}
