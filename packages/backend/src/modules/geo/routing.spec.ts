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

      // No mock: the provider computes great-circle distance in process rather than asking
      // Postgres for arithmetic, so this now exercises the real maths. One degree of latitude
      // is 111.19 km (R = 6371 km), and each leg is rounded to 2dp before being summed:
      // 111.19 + 111.19 = 222.38. The old expectation of 222.6 came from this test's own mock,
      // which invented 111.3 km per degree.
      const result = await postGISProvider.optimizeRoute(origin, destinations, false);

      expect(result.optimizedSequence).toEqual(['branch-1', 'branch-2']);
      expect(result.totalDistanceKm).toBe(222.38);
      expect(result.steps.length).toBe(2);
      // And no database round trip was taken to work that out.
      expect(mockDataSource.query).not.toHaveBeenCalled();
    });

    it('should include return path to origin when roundTrip is enabled', async () => {
      const origin = { latitude: 0, longitude: 0 };
      const destinations = [
        { id: 'branch-1', latitude: 0, longitude: 1 },
      ];

      const result = await postGISProvider.optimizeRoute(origin, destinations, true);

      expect(result.optimizedSequence).toEqual(['branch-1']);
      // 111.19 out to branch-1 on the equator + 111.19 back to origin, each rounded to 2dp.
      expect(result.totalDistanceKm).toBe(222.38);
      expect(mockDataSource.query).not.toHaveBeenCalled();
    });
  });
});
