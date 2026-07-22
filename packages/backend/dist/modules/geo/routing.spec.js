"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const routing_provider_1 = require("./routing.provider");
const typeorm_1 = require("typeorm");
const config_1 = require("@nestjs/config");
describe('Geo Routing & Optimization', () => {
    let routingService;
    let postGISProvider;
    let osrmProvider;
    const mockDataSource = {
        query: jest.fn(),
    };
    const mockConfigService = {
        get: jest.fn().mockReturnValue('POSTGIS'),
    };
    beforeEach(async () => {
        const module = await testing_1.Test.createTestingModule({
            providers: [
                routing_provider_1.RoutingService,
                routing_provider_1.PostGISRoutingProvider,
                routing_provider_1.OSRMRoutingProvider,
                {
                    provide: typeorm_1.DataSource,
                    useValue: mockDataSource,
                },
                {
                    provide: config_1.ConfigService,
                    useValue: mockConfigService,
                },
            ],
        }).compile();
        routingService = module.get(routing_provider_1.RoutingService);
        postGISProvider = module.get(routing_provider_1.PostGISRoutingProvider);
        osrmProvider = module.get(routing_provider_1.OSRMRoutingProvider);
        jest.clearAllMocks();
    });
    describe('optimizeRoute', () => {
        it('should correctly solve TSP nearest-neighbor sequence', async () => {
            const origin = { latitude: 0, longitude: 0 };
            const destinations = [
                { id: 'branch-2', latitude: 2, longitude: 0 },
                { id: 'branch-1', latitude: 1, longitude: 0 },
            ];
            mockDataSource.query.mockImplementation(async (sql, params) => {
                const fromLat = params[1];
                const toLat = params[3];
                const distanceKm = Math.abs(fromLat - toLat) * 111.3;
                return [{ distanceKm }];
            });
            const result = await postGISProvider.optimizeRoute(origin, destinations, false);
            expect(result.optimizedSequence).toEqual(['branch-1', 'branch-2']);
            expect(result.totalDistanceKm).toBe(222.6);
            expect(result.steps.length).toBe(2);
        });
        it('should include return path to origin when roundTrip is enabled', async () => {
            const origin = { latitude: 0, longitude: 0 };
            const destinations = [
                { id: 'branch-1', latitude: 0, longitude: 1 },
            ];
            mockDataSource.query.mockResolvedValue([{ distanceKm: 111.3 }]);
            const result = await postGISProvider.optimizeRoute(origin, destinations, true);
            expect(result.optimizedSequence).toEqual(['branch-1']);
            expect(result.totalDistanceKm).toBe(222.6);
        });
    });
});
//# sourceMappingURL=routing.spec.js.map