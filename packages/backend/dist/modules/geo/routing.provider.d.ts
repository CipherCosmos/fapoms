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
    calculateRoute(origin: {
        latitude: number;
        longitude: number;
    }, destination: {
        latitude: number;
        longitude: number;
    }): Promise<RouteResult>;
    calculateDistances(origin: {
        latitude: number;
        longitude: number;
    }, destinations: DestinationCoords[]): Promise<Record<string, RouteResult>>;
}
export declare class PostGISRoutingProvider implements RoutingProvider {
    private readonly dataSource;
    constructor(dataSource: DataSource);
    calculateRoute(origin: {
        latitude: number;
        longitude: number;
    }, destination: {
        latitude: number;
        longitude: number;
    }): Promise<RouteResult>;
    calculateDistances(origin: {
        latitude: number;
        longitude: number;
    }, destinations: DestinationCoords[]): Promise<Record<string, RouteResult>>;
}
export declare class OSRMRoutingProvider implements RoutingProvider {
    private readonly configService;
    private readonly postGISProvider;
    private readonly baseUrl;
    constructor(configService: ConfigService, postGISProvider: PostGISRoutingProvider);
    calculateRoute(origin: {
        latitude: number;
        longitude: number;
    }, destination: {
        latitude: number;
        longitude: number;
    }): Promise<RouteResult>;
    calculateDistances(origin: {
        latitude: number;
        longitude: number;
    }, destinations: DestinationCoords[]): Promise<Record<string, RouteResult>>;
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
    }): Promise<RouteResult>;
    calculateDistances(origin: {
        latitude: number;
        longitude: number;
    }, destinations: DestinationCoords[]): Promise<Record<string, RouteResult>>;
}
