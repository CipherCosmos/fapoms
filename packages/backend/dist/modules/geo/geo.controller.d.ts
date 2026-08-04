import { Repository } from 'typeorm';
import { RoutingService, DestinationCoords } from './routing.provider';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from './geo.entities';
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
    mode?: 'driving' | 'walking' | 'cycling';
}
export declare class GeoController {
    private readonly routingService;
    private readonly stateRepo;
    private readonly districtRepo;
    private readonly cityRepo;
    constructor(routingService: RoutingService, stateRepo: Repository<GeoStateEntity>, districtRepo: Repository<GeoDistrictEntity>, cityRepo: Repository<GeoCityEntity>);
    autocomplete(q?: string): Promise<{
        success: boolean;
        data: import("./india-autocomplete.helper").IndiaPlaceResult[];
    }>;
    getStates(): Promise<{
        success: boolean;
        data: GeoStateEntity[];
    }>;
    getDistricts(stateId: string): Promise<{
        success: boolean;
        data: GeoDistrictEntity[];
    }>;
    getCities(districtId: string): Promise<{
        success: boolean;
        data: GeoCityEntity[];
    }>;
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
