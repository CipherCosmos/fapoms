import { RoutingService, DestinationCoords } from './routing.provider';
export declare class CoordinateDto {
    latitude: number;
    longitude: number;
}
export declare class DestinationDto extends CoordinateDto implements DestinationCoords {
    id: string;
}
export declare class OptimizeRouteDto {
    origin: CoordinateDto;
    destinations: DestinationDto[];
    roundTrip?: boolean;
}
export declare class GeoController {
    private readonly routingService;
    constructor(routingService: RoutingService);
    optimizeRoute(dto: OptimizeRouteDto): Promise<{
        success: boolean;
        data: {
            optimizedSequence: string[];
            totalDistanceKm: number;
            totalDurationMinutes: number;
            steps: {
                destinationId: string;
                distanceKm: number;
                durationMinutes: number;
            }[];
        };
    }>;
}
