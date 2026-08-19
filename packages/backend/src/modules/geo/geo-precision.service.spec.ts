import { GeoPrecisionService } from './geo-precision.service';
import { GEO_PRECISION_TARGETED_JOB } from './geo-precision.constants';

/**
 * The coordinate-resolution chain is stubbed so nothing here touches the network or the on-disk
 * geo cache. What is under test is selection (which rows the backfill asks the database for,
 * in what order, bounded how) and the hand-off to the queue — not geocoding itself.
 */
jest.mock('./coordinate-resolution', () => {
  const actual = jest.requireActual('./coordinate-resolution');
  return { ...actual, resolveCoordinates: jest.fn() };
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveCoordinates: mockResolve } = require('./coordinate-resolution') as { resolveCoordinates: jest.Mock };

describe('GeoPrecisionService', () => {
  let service: GeoPrecisionService;
  let qb: any;
  let branchRepo: any;
  let queue: { add: jest.Mock };

  const chain = () => {
    qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    return qb;
  };

  beforeEach(() => {
    branchRepo = { createQueryBuilder: jest.fn(() => chain()), save: jest.fn(async (r: any) => r) };
    const assayerRepo = { createQueryBuilder: jest.fn(() => chain()), save: jest.fn(async (r: any) => r) };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    service = new GeoPrecisionService(
      branchRepo as any,
      assayerRepo as any,
      { recordEventSafe: jest.fn() } as any,
      queue as any,
    );
    mockResolve.mockReset();
  });

  describe('backfill — selection', () => {
    /**
     * The bug this pins down: selection used to be `find({ isActive: true, take: limit * 4 })`
     * with rows filtered in memory. On a table whose first rows were already precise the run
     * examined none of them and returned — never reaching the coarse rows further down.
     */
    it('asks the database only for rows that need a better fix, worst first, bounded by limit', async () => {
      await service.backfill('branch', 25);

      expect(branchRepo.createQueryBuilder).toHaveBeenCalledWith('r');
      expect(qb.where).toHaveBeenCalledWith('r.is_active = true');
      // Manual pins excluded in SQL, not skipped after the fact.
      expect(qb.andWhere).toHaveBeenCalledWith("(r.geo_source IS NULL OR r.geo_source <> 'manual')");
      // The needsBetterFix predicate, in SQL: never resolved or coarser than the pincode tier.
      expect(qb.andWhere).toHaveBeenCalledWith(
        '(r.geo_source IS NULL OR r.geo_accuracy_meters IS NULL OR r.geo_accuracy_meters > :pin)',
        { pin: 3000 },
      );
      // Worst placed first (a state centroid before a district one), then longest waiting.
      expect(qb.orderBy).toHaveBeenCalledWith('r.geo_accuracy_meters', 'DESC', 'NULLS FIRST');
      expect(qb.addOrderBy).toHaveBeenCalledWith('r.geo_resolved_at', 'ASC', 'NULLS FIRST');
      // The bound applies to rows actually worked — not limit*4 with in-memory skipping.
      expect(qb.take).toHaveBeenCalledWith(25);
    });

    it('narrows to the given ids when an import hands over its own rows', async () => {
      await service.backfill('branch', 50, ['b-1', 'b-2']);
      expect(qb.andWhere).toHaveBeenCalledWith('r.id IN (:...ids)', { ids: ['b-1', 'b-2'] });
    });

    it('does not add an id filter when none are given (the nightly sweep)', async () => {
      await service.backfill('branch', 50);
      const idFilter = qb.andWhere.mock.calls.find((c: any[]) => String(c[0]).includes('r.id IN'));
      expect(idFilter).toBeUndefined();
    });
  });

  describe('backfill — what it writes', () => {
    const coarseRow = () => ({
      id: 'b-1', name: 'Thenkurissi', branchCode: 'BR-1', address: '1 Main Rd', city: 'Palakkad',
      district: 'Palakkad', state: 'Kerala', pincode: '678001', clientId: null,
      latitude: 10.5, longitude: 76.5, geoSource: 'locality', geoAccuracyMeters: 15000,
    });

    it('writes an improvement and reports how far the pin moved', async () => {
      branchRepo.createQueryBuilder = jest.fn(() => { const c = chain(); c.getMany.mockResolvedValue([coarseRow()]); return c; });
      mockResolve.mockResolvedValue({
        latitude: 10.78, longitude: 76.65, location: { type: 'Point', coordinates: [76.65, 10.78] },
        geoSource: 'osm_locality', geoAccuracyMeters: 900, geoMatchedName: 'Thenkurissi', geoResolvedAt: new Date(),
      });

      const report = await service.backfill('branch', 10);

      expect(report).toMatchObject({ examined: 1, improved: 1, unchanged: 0 });
      expect(branchRepo.save).toHaveBeenCalledWith(expect.objectContaining({ geoSource: 'osm_locality', geoAccuracyMeters: 900 }));
      expect(report.movedKm[0]).toMatchObject({ from: 'locality', to: 'osm_locality' });
      expect(report.movedKm[0].km).toBeGreaterThan(10);
    });

    it('leaves a row alone when the free chain cannot do better — no churn for no gain', async () => {
      branchRepo.createQueryBuilder = jest.fn(() => { const c = chain(); c.getMany.mockResolvedValue([coarseRow()]); return c; });
      // Same tier back: no improvement.
      mockResolve.mockResolvedValue({
        latitude: 10.51, longitude: 76.49, location: { type: 'Point', coordinates: [76.49, 10.51] },
        geoSource: 'locality', geoAccuracyMeters: 15000, geoMatchedName: null, geoResolvedAt: new Date(),
      });

      const report = await service.backfill('branch', 10);

      expect(report).toMatchObject({ examined: 1, improved: 0, unchanged: 1 });
      expect(branchRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('enqueueBackfill', () => {
    it('queues the ids in chunks of 50, deduplicated, and never throws', async () => {
      const ids = Array.from({ length: 120 }, (_, i) => `b-${i}`).concat(['b-0', 'b-1']);
      await service.enqueueBackfill('branch', ids, 'import into project p-1');

      expect(queue.add).toHaveBeenCalledTimes(3); // 120 unique → 50 + 50 + 20
      const [name, data] = queue.add.mock.calls[0];
      expect(name).toBe(GEO_PRECISION_TARGETED_JOB);
      expect(data).toMatchObject({ target: 'branch', reason: 'import into project p-1' });
      expect(data.ids).toHaveLength(50);
    });

    it('is a no-op for an empty list', async () => {
      await service.enqueueBackfill('branch', [], 'nothing');
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('swallows a queue failure — an import that already landed must not fail for it', async () => {
      queue.add.mockRejectedValue(new Error('redis down'));
      await expect(service.enqueueBackfill('branch', ['b-1'], 'import')).resolves.toBeUndefined();
    });
  });
});
