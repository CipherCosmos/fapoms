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
  let assayerRepo: any;
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
    assayerRepo = { createQueryBuilder: jest.fn(() => chain()), save: jest.fn(async (r: any) => r) };
    const zoneRepo = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn((d: any) => d), save: jest.fn(async (z: any) => ({ id: 'z-1', ...z })) };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    service = new GeoPrecisionService(
      branchRepo as any,
      assayerRepo as any,
      zoneRepo as any,
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
      /**
       * Worst placed first (a state centroid before a district one), then longest waiting.
       *
       * By property path, not column name: the predicates above are passed through to SQL
       * untouched, but an ordering term is looked up in the entity metadata the moment a query
       * joins a relation and takes a limit. This one has no joins so either spelling runs — the
       * neighbouring Falling Behind query did have joins, and its column-named ordering was a
       * 500 on every request. One spelling everywhere is what keeps that from being luck.
       */
      expect(qb.orderBy).toHaveBeenCalledWith('r.geoAccuracyMeters', 'DESC', 'NULLS FIRST');
      expect(qb.addOrderBy).toHaveBeenCalledWith('r.geoResolvedAt', 'ASC', 'NULLS FIRST');
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
      id: 'b-1', name: 'Thenkurissi', solId: 'BR-1', address: '1 Main Rd', city: 'Palakkad',
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

  /**
   * What a record IS decides which providers may be asked about it.
   *
   * `name`/`brand` feed the POI ladder: a Photon search for the named place, then an Overpass
   * search for `amenity=bank|atm` near the anchor, ranked against that name. Right for a branch,
   * wrong by construction for an appraiser's home — nobody's house is mapped in OSM under their
   * name, and it is not a bank. The backfill was sending `displayName` there, which asked both
   * providers to find a person among the ATMs near their pincode; anything that came back and
   * passed verification would have been written onto them as a precise home address.
   *
   * It was also where the time went. Both providers are public and rate-limited, so `politely`
   * chains them process-wide — 1.1s and 2.5s on every row, however many rows run at once.
   */
  describe('backfill — who the providers are asked about', () => {
    const person = () => ({
      id: 'a-1', displayName: 'Ramesh Kumar', address: '12 Kadavanthra Rd', city: 'Kochi',
      district: 'Ernakulam', state: 'Kerala', pincode: '682020',
      latitude: null, longitude: null, geoSource: null, geoAccuracyMeters: null,
    });

    const placed = {
      latitude: 9.97, longitude: 76.3, location: { type: 'Point', coordinates: [76.3, 9.97] },
      geoSource: 'pincode', geoAccuracyMeters: 2000, geoMatchedName: '682020', geoResolvedAt: new Date(),
    };

    it("never sends an appraiser's own name as a place name", async () => {
      assayerRepo.createQueryBuilder = jest.fn(() => { const c = chain(); c.getMany.mockResolvedValue([person()]); return c; });
      mockResolve.mockResolvedValue(placed);

      await service.backfill('assayer', 10);

      const parts = mockResolve.mock.calls[0][0];
      expect(parts.name).toBeNull();
      expect(parts.brand).toBeNull();
      // The address tiers are how a home is actually placed, and must still be sent.
      expect(parts).toMatchObject({ address: '12 Kadavanthra Rd', pincode: '682020', city: 'Kochi' });
    });

    it("still sends a branch's name and its client's brand, which is what the POI ladder is for", async () => {
      branchRepo.createQueryBuilder = jest.fn(() => {
        const c = chain();
        c.getMany.mockResolvedValue([{
          id: 'b-1', name: 'Aundh Branch', solId: 'BR-1', address: '1 Main Rd', city: 'Pune',
          district: 'Pune', state: 'Maharashtra', pincode: '411007', clientId: null,
          latitude: 18.5, longitude: 73.8, geoSource: 'locality', geoAccuracyMeters: 15000,
        }]);
        return c;
      });
      mockResolve.mockResolvedValue({ ...placed, geoSource: 'osm_building', geoAccuracyMeters: 10 });

      await service.backfill('branch', 10);

      expect(mockResolve.mock.calls[0][0].name).toBe('Aundh Branch');
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
