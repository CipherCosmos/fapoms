import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';

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
  ): Promise<RouteResult>;

  calculateDistances(
    origin: { latitude: number; longitude: number },
    destinations: DestinationCoords[],
  ): Promise<Record<string, RouteResult>>;
}

@Injectable()
export class PostGISRoutingProvider implements RoutingProvider {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async calculateRoute(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
  ): Promise<RouteResult> {
    const raw = await this.dataSource.query(
      `SELECT ST_DistanceSphere(
        ST_SetSRID(ST_MakePoint($1, $2), 4326),
        ST_SetSRID(ST_MakePoint($3, $4), 4326)
      ) / 1000 AS "distanceKm"`,
      [origin.longitude, origin.latitude, destination.longitude, destination.latitude],
    );
    const distanceKm = raw[0]?.distanceKm ? parseFloat(raw[0].distanceKm) : 0;
    // Assume average driving speed of 50 km/h for straight-line conversion
    const durationMinutes = (distanceKm / 50) * 60;
    return {
      distanceKm: parseFloat(distanceKm.toFixed(2)),
      durationMinutes: parseFloat(durationMinutes.toFixed(2)),
    };
  }

  async calculateDistances(
    origin: { latitude: number; longitude: number },
    destinations: DestinationCoords[],
  ): Promise<Record<string, RouteResult>> {
    const results: Record<string, RouteResult> = {};
    for (const dest of destinations) {
      results[dest.id] = await this.calculateRoute(origin, dest);
    }
    return results;
  }
}

@Injectable()
export class OSRMRoutingProvider implements RoutingProvider {
  private readonly baseUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly postGISProvider: PostGISRoutingProvider,
  ) {
    this.baseUrl = this.configService.get<string>(
      'OSRM_URL',
      'https://router.project-osrm.org',
    );
  }

  async calculateRoute(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
  ): Promise<RouteResult> {
    try {
      const url = `${this.baseUrl}/route/v1/driving/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}?overview=false`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OSRM HTTP error: ${res.status}`);
      const data = await res.json();
      if (data.code === 'Ok' && data.routes?.[0]) {
        const route = data.routes[0];
        return {
          distanceKm: parseFloat((route.distance / 1000).toFixed(2)),
          durationMinutes: parseFloat((route.duration / 60).toFixed(2)),
        };
      }
    } catch (e) {
      // Fallback silently to PostGIS
    }
    return this.postGISProvider.calculateRoute(origin, destination);
  }

  async calculateDistances(
    origin: { latitude: number; longitude: number },
    destinations: DestinationCoords[],
  ): Promise<Record<string, RouteResult>> {
    try {
      const coords = [
        `${origin.longitude},${origin.latitude}`,
        ...destinations.map((d) => `${d.longitude},${d.latitude}`),
      ].join(';');
      const url = `${this.baseUrl}/table/v1/driving/${coords}?sources=0`;
      const res = await fetch(url);
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
    } catch (e) {
      // Fallback to PostGIS
    }
    return this.postGISProvider.calculateDistances(origin, destinations);
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
  ): Promise<RouteResult> {
    return this.activeProvider.calculateRoute(origin, destination);
  }

  async calculateDistances(
    origin: { latitude: number; longitude: number },
    destinations: DestinationCoords[],
  ): Promise<Record<string, RouteResult>> {
    return this.activeProvider.calculateDistances(origin, destinations);
  }
}
