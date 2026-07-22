import { Test, TestingModule } from '@nestjs/testing';
import { PostGISRoutingProvider, OSRMRoutingProvider, RoutingService } from './routing.provider';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';

describe('Geo Routing & Optimization', () => {
  let routingService: RoutingService;
  let postGISProvider: PostGISRoutingProvider;
  let osrmProvider: OSRMRoutingProvider;

  const mockDataSource = {
    query: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue('POSTGIS'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutingService,
        PostGISRoutingProvider,
        OSRMRoutingProvider,
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    routingService = module.get<RoutingService>(RoutingService);
    postGISProvider = module.get<PostGISRoutingProvider>(PostGISRoutingProvider);
    osrmProvider = module.get<OSRMRoutingProvider>(OSRMRoutingProvider);

    jest.clearAllMocks();
  });

  describe('optimizeRoute', () => {
    it('should correctly solve TSP nearest-neighbor sequence', async () => {
      // Setup coordinates: Origin at (0, 0), Branch 1 at (0, 1), Branch 2 at (0, 2)
      // Expected nearest path: origin (0,0) -> Branch 1 (0,1) -> Branch 2 (0,2)
      const origin = { latitude: 0, longitude: 0 };
      const destinations = [
        { id: 'branch-2', latitude: 2, longitude: 0 },
        { id: 'branch-1', latitude: 1, longitude: 0 },
      ];

      // Mock PostGIS distance query (ST_DistanceSphere returns meters)
      // (0,0) to (0,1) = 111.3 * 1000 meters
      // (0,0) to (0,2) = 222.6 * 1000 meters
      // (0,1) to (0,2) = 111.3 * 1000 meters
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
      expect(result.totalDistanceKm).toBe(222.6); // 111.3 to branch-1 + 111.3 back to origin
    });
  });
});
