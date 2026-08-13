import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { LocationTrailService } from './location-trail.service';
import { AssayerLocationPingEntity } from './assayer-location-ping.entity';

/**
 * Ingestion is the gate between "a handset said something" and "the platform holds evidence".
 * Everything it lets through can later be used to question somebody's travel claim, so the cases
 * below are about refusing to record things that would misrepresent a journey in either direction.
 */
describe('LocationTrailService', () => {
  let service: LocationTrailService;

  const insertBuilder = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };

  const mockRepo = {
    create: jest.fn((v: any) => v),
    find: jest.fn().mockResolvedValue([]),
    query: jest.fn().mockResolvedValue([[], 0]),
    createQueryBuilder: jest.fn(() => insertBuilder),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationTrailService,
        { provide: getRepositoryToken(AssayerLocationPingEntity), useValue: mockRepo },
      ],
    }).compile();
    service = module.get(LocationTrailService);
    jest.clearAllMocks();
    // Default: every supplied row is newly inserted.
    insertBuilder.execute.mockImplementation(async () => ({
      identifiers: (insertBuilder.values.mock.calls.at(-1)?.[0] ?? []).map(() => ({ id: 'x' })),
    }));
  });

  const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const ping = (minutesAgo: number, over: Record<string, unknown> = {}) => ({
    latitude: 10.5,
    longitude: 76.2,
    accuracyMeters: 20,
    recordedAt: iso(minutesAgo),
    ...over,
  });

  describe('ingest', () => {
    it('stores a batch of valid fixes', async () => {
      const r = await service.ingest('as-1', [ping(3), ping(2), ping(1)]);

      expect(r.accepted).toBe(3);
      expect(r.rejected).toEqual([]);
    });

    /**
     * The failure that silently doubles a distance. The field app flushes what it queued while
     * offline and retries on failure, so a re-sent batch is routine — and counting it twice would
     * inflate the exact number this record exists to test a claim against. Enforced on a unique
     * index, which is why `orIgnore` must be part of the insert.
     */
    it('relies on ON CONFLICT so a retried batch cannot be counted twice', async () => {
      // The database reports only one row actually inserted out of the two offered.
      insertBuilder.execute.mockResolvedValueOnce({ identifiers: [{ id: 'x' }, undefined] });

      const r = await service.ingest('as-1', [ping(2), ping(1)]);

      expect(insertBuilder.orIgnore).toHaveBeenCalled();
      expect(r.accepted).toBe(1);
      expect(r.duplicates).toBe(1);
    });

    it('collapses an instant repeated inside a single batch', async () => {
      const t = iso(5);
      const r = await service.ingest('as-1', [ping(5, { recordedAt: t }), ping(5, { recordedAt: t })]);

      // The second is dropped before the insert, so the unique index never has to reject the batch.
      expect(r.duplicates).toBe(1);
      expect(insertBuilder.values.mock.calls.at(-1)?.[0]).toHaveLength(1);
    });

    /**
     * One malformed row must not discard the rest. A handset flushing six hours of queued fixes
     * after a day in a rural area is the normal case, and refusing the whole upload over a single
     * bad timestamp would throw away the evidence an honest assayer needs.
     */
    it('rejects only the bad rows and keeps the good ones', async () => {
      const r = await service.ingest('as-1', [
        ping(3),
        ping(2, { latitude: 999 }),
        ping(1, { recordedAt: 'not-a-date' }),
        ping(0),
      ]);

      expect(r.accepted).toBe(2);
      expect(r.rejected).toHaveLength(2);
      expect(r.rejected[0].index).toBe(1);
      expect(r.rejected[1].index).toBe(2);
    });

    it('refuses Null Island, which is a failed fix rather than a position', async () => {
      const r = await service.ingest('as-1', [ping(1, { latitude: 0, longitude: 0 })]);

      expect(r.accepted).toBe(0);
      expect(r.rejected[0].reason).toContain('failed fix');
    });

    /**
     * A fix timestamped into the future would sit outside every verification window — evidence
     * parked where no query looks for it. A few minutes of handset clock drift is tolerated.
     */
    it('refuses a fix dated into the future beyond clock drift', async () => {
      const future = new Date(Date.now() + 60 * 60_000).toISOString();

      const r = await service.ingest('as-1', [ping(1, { recordedAt: future })]);

      expect(r.accepted).toBe(0);
      expect(r.rejected[0].reason).toContain('future');
    });

    it('accepts a fix a few minutes ahead, because handset clocks drift', async () => {
      const slightlyAhead = new Date(Date.now() + 2 * 60_000).toISOString();

      const r = await service.ingest('as-1', [ping(1, { recordedAt: slightlyAhead })]);

      expect(r.accepted).toBe(1);
    });

    it('refuses an oversized batch rather than letting a client flood the trail', async () => {
      const many = Array.from({ length: 1001 }, (_, i) => ping(i + 1));

      await expect(service.ingest('as-1', many)).rejects.toThrow(BadRequestException);
    });

    it('refuses an empty upload', async () => {
      await expect(service.ingest('as-1', [])).rejects.toThrow(BadRequestException);
    });

    it('preserves a mock-provider flag instead of dropping the fix', async () => {
      await service.ingest('as-1', [ping(1, { isMocked: true })]);

      // Dropping it would discard the strongest tamper evidence the platform can get.
      expect(insertBuilder.values.mock.calls.at(-1)?.[0][0]).toMatchObject({ isMocked: true });
    });

    it('writes a PostGIS point alongside the numeric pair', async () => {
      await service.ingest('as-1', [ping(1)]);

      expect(insertBuilder.values.mock.calls.at(-1)?.[0][0]).toMatchObject({
        location: { type: 'Point', coordinates: [76.2, 10.5] },
      });
    });
  });

  describe('record', () => {
    it('never throws, so a failed trail write cannot fail the action it accompanies', async () => {
      insertBuilder.execute.mockRejectedValueOnce(new Error('db down'));

      await expect(service.record('as-1', 10.5, 76.2)).resolves.toBeUndefined();
    });
  });

  describe('assessAssignmentTravel', () => {
    it('declines to assess a journey with no check-in to anchor it', async () => {
      // With no verified end point there is no journey to speak about, only a day's wandering.
      await expect(
        service.assessAssignmentTravel({ assayerId: 'as-1', checkedInAt: null }),
      ).resolves.toBeNull();
      expect(mockRepo.find).not.toHaveBeenCalled();
    });

    it('reads the window backwards from the check-in and reports on it', async () => {
      const checkedInAt = new Date();
      mockRepo.find.mockResolvedValueOnce([]);

      const a = await service.assessAssignmentTravel({
        assayerId: 'as-1',
        checkedInAt,
        expectedDistanceKm: 40,
        lookbackHours: 6,
      });

      expect(a?.verdict).toBe('NO_DATA');
      expect(a?.expectedDistanceKm).toBe(40);
    });

    it('says an empty trail means sharing was off, when it was', async () => {
      mockRepo.find.mockResolvedValueOnce([]);

      const a = await service.assessAssignmentTravel({
        assayerId: 'as-1',
        checkedInAt: new Date(),
        trackingEnabled: false,
      });

      // "Nobody could see" and "the feature was off" are different facts about different people.
      expect(a?.verdict).toBe('NO_DATA');
      expect(a?.summary).toContain('switched off');
      expect(a?.summary).toContain('not evidence about the travel');
    });

    /**
     * The window has to fit the journey. Sized at a flat 12 hours, a 45-minute drive scores ~6%
     * coverage and the assessment is permanently non-committal however complete the trail of the
     * actual journey was — the question silently becomes "was your phone on all day?".
     */
    describe('window sizing', () => {
      const windowHoursUsed = () => {
        const where = mockRepo.find.mock.calls.at(-1)![0].where.recordedAt;
        // TypeORM's Between operator carries [from, to].
        const [from, to] = where.value as [Date, Date];
        return (to.getTime() - from.getTime()) / 3_600_000;
      };

      it('scales the window to the claimed distance', async () => {
        mockRepo.find.mockResolvedValueOnce([]);
        // 90 km at a pessimistic 30 km/h average.
        await service.assessAssignmentTravel({ assayerId: 'as-1', checkedInAt: new Date(), expectedDistanceKm: 90 });

        expect(windowHoursUsed()).toBeCloseTo(3, 1);
      });

      it('gives a short hop at least an hour', async () => {
        mockRepo.find.mockResolvedValueOnce([]);
        await service.assessAssignmentTravel({ assayerId: 'as-1', checkedInAt: new Date(), expectedDistanceKm: 5 });

        expect(windowHoursUsed()).toBeCloseTo(1, 1);
      });

      it('refuses to search back further than twelve hours for an implausible claim', async () => {
        mockRepo.find.mockResolvedValueOnce([]);
        await service.assessAssignmentTravel({ assayerId: 'as-1', checkedInAt: new Date(), expectedDistanceKm: 5000 });

        expect(windowHoursUsed()).toBeCloseTo(12, 1);
      });

      it('falls back to a working-day leg when no distance was claimed', async () => {
        mockRepo.find.mockResolvedValueOnce([]);
        await service.assessAssignmentTravel({ assayerId: 'as-1', checkedInAt: new Date() });

        expect(windowHoursUsed()).toBeCloseTo(4, 1);
      });
    });
  });

  /**
   * Retention is a policy decision about how long to keep movement records of identifiable
   * workers. The mechanism exists; the number is deliberately not chosen here.
   */
  describe('purgeOlderThanRetention', () => {
    const RETENTION = 'LOCATION_TRAIL_RETENTION_DAYS';
    afterEach(() => { delete process.env[RETENTION]; });

    it('deletes nothing at all when no retention window is configured', async () => {
      delete process.env[RETENTION];

      const r = await service.purgeOlderThanRetention();

      // Silently destroying evidence somebody may need to defend a claim is worse than a
      // growing table, which is at least a visible problem with an owner.
      expect(r).toEqual({ configured: false, deleted: 0 });
      expect(mockRepo.query).not.toHaveBeenCalled();
    });

    it('ignores a nonsensical retention value rather than deleting everything', async () => {
      process.env[RETENTION] = '0';
      expect(await service.purgeOlderThanRetention()).toEqual({ configured: false, deleted: 0 });

      process.env[RETENTION] = 'soon';
      expect(await service.purgeOlderThanRetention()).toEqual({ configured: false, deleted: 0 });

      expect(mockRepo.query).not.toHaveBeenCalled();
    });

    it('deletes a bounded slice older than the cutoff when configured', async () => {
      process.env[RETENTION] = '90';
      mockRepo.query.mockResolvedValueOnce([[], 120]);

      const r = await service.purgeOlderThanRetention(500);

      expect(r).toEqual({ configured: true, deleted: 120 });
      const [sql, params] = mockRepo.query.mock.calls.at(-1)!;
      expect(sql).toContain('LIMIT');
      expect(params[1]).toBe(500);
      // The cutoff is 90 days back, not "now".
      const cutoff = params[0] as Date;
      const daysBack = (Date.now() - cutoff.getTime()) / 86_400_000;
      expect(daysBack).toBeCloseTo(90, 0);
    });
  });
});
