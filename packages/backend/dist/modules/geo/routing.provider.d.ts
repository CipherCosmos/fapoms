import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
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
    calculateRoute(origin: {
        latitude: number;
        longitude: number;
    }, destination: {
        latitude: number;
        longitude: number;
    }, mode?: RoutingMode): Promise<RouteResult>;
    calculateDistances(origin: {
        latitude: number;
        longitude: number;
    }, destinations: DestinationCoords[], mode?: RoutingMode): Promise<Record<string, RouteResult>>;
    optimizeRoute(origin: {
        latitude: number;
        longitude: number;
    }, destinations: DestinationCoords[], roundTrip?: boolean, mode?: RoutingMode): Promise<{
        optimizedSequence: string[];
        totalDistanceKm: number;
        totalDurationMinutes: number;
        steps: {
            destinationId: string;
            distanceKm: number;
            durationMinutes: number;
        }[];
    }>;
}
export declare class PostGISRoutingProvider implements RoutingProvider {
    private readonly dataSource;
    constructor(dataSource: DataSource);
    private modeSpeed;
    calculateRoute(origin: {
        latitude: number;
        longitude: number;
    }, destination: {
        latitude: number;
        longitude: number;
    }, mode?: RoutingMode): Promise<RouteResult>;
    calculateDistances(origin: {
        latitude: number;
        longitude: number;
    }, destinations: DestinationCoords[], mode?: RoutingMode): Promise<Record<string, RouteResult>>;
    optimizeRoute(origin: {
        latitude: number;
        longitude: number;
    }, destinations: DestinationCoords[], roundTrip?: boolean, mode?: RoutingMode): Promise<{
        optimizedSequence: string[];
        totalDistanceKm: number;
        totalDurationMinutes: number;
        steps: {
            destinationId: string;
            distanceKm: number;
            durationMinutes: number;
        }[];
    }>;
}
export declare class OSRMRoutingProvider implements RoutingProvider {
    private readonly configService;
    private readonly postGISProvider;
    private readonly baseUrl;
    constructor(configService: ConfigService, postGISProvider: PostGISRoutingProvider);
    private osrmProfile;
    calculateRoute(origin: {
        latitude: number;
        longitude: number;
    }, destination: {
        latitude: number;
        longitude: number;
    }, mode?: RoutingMode): Promise<RouteResult>;
    calculateDistances(origin: {
        latitude: number;
        longitude: number;
    }, destinations: DestinationCoords[], mode?: RoutingMode): Promise<Record<string, RouteResult>>;
    optimizeRoute(origin: {
        latitude: number;
        longitude: number;
    }, destinations: DestinationCoords[], roundTrip?: boolean, mode?: RoutingMode): Promise<{
        optimizedSequence: string[];
        totalDistanceKm: number;
        totalDurationMinutes: number;
        steps: {
            destinationId: string;
            distanceKm: number;
            durationMinutes: number;
        }[];
    }>;
}
export declare class RoutingService {
    private readonly configService;
    private readonly postGISProvider;
    private readonly osrmProvider;
    private activeProvider;
    constructor(configService: ConfigService, postGISProvider: PostGISRoutingProvider, osrmProvider: OSRMRoutingProvider);
    calculateRoute(origin: {
        latitude: number;
        longitude: number;
    }, destination: {
        latitude: number;
        longitude: number;
    }, mode?: RoutingMode): Promise<RouteResult>;
    calculateDistances(origin: {
        latitude: number;
        longitude: number;
    }, destinations: DestinationCoords[], mode?: RoutingMode): Promise<Record<string, RouteResult>>;
    optimizeRoute(origin: {
        latitude: number;
        longitude: number;
    }, destinations: DestinationCoords[], roundTrip?: boolean, mode?: RoutingMode): Promise<{
        optimizedSequence: string[];
        totalDistanceKm: number;
        totalDurationMinutes: number;
        steps: {
            destinationId: string;
            distanceKm: number;
            durationMinutes: number;
        }[];
    }>;
}
