import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { HrWorkforceService } from './hr-workforce.service';
import { CacheService } from '../../infrastructure/cache/cache.service';

/**
 * Every count on the HR console describes the workforce, not the page.
 *
 * Three of these panels ship a capped list — a hundred rows, so a page cannot be asked to
 * render five thousand — and then counted the cap. The result was two numbers for the same
 * roster sitting next to each other on one screen: "Records complete 4,938 / 5,038" beside a
 * bar reading "Bank account 238 / 5,038", because the first was `incomplete.length` against a
 * `LIMIT 100` and the second was a real aggregate.
 *
 * The expiry buckets failed worse than that. They were counted in JS over the hundred soonest
 * rows, so a backlog of already-expired credentials filled the whole window and the console
 * reported "0 expiring within 30 days" — the quietest possible answer at exactly the moment
 * there was most to renew, and the renewal action derived from that figure vanished with it.
 */
describe('HrWorkforceService counts', () => {
  let service: HrWorkforceService;
  const query = jest.fn();

  /** A hundred rows, which is what each capped query is allowed to return. */
  const cappedRows = (fields: Record<string, unknown>) =>
    Array.from({ length: 100 }, (_, i) => ({ id: `row-${i}`, ...fields }));

  beforeEach(async () => {
    query.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HrWorkforceService,
        { provide: getDataSourceToken(), useValue: { query } as unknown as DataSource },
        // Straight through — the cache is not what these tests are about.
        { provide: CacheService, useValue: { wrap: async (_k: string, _t: number, fn: any) => fn() } },
      ],
    }).compile();
    service = module.get(HrWorkforceService);
  });

  describe('incomplete records', () => {
    it('counts the whole roster, not the hundred rows it can show', async () => {
      query.mockImplementation(async (sql: string) => {
        // The aggregate: no LIMIT, one row, the true figure.
        if (sql.includes('COUNT(*)::int AS count') && sql.includes('ARRAY_LENGTH') === false
            && sql.includes('FROM assayers') && !sql.includes('LIMIT')) {
          return [{ count: 4800 }];
        }
        if (sql.includes('ARRAY_REMOVE')) return cappedRows({ missing: ['bank_account_number'] });
        if (sql.includes('COUNT(*) FILTER')) return [{ total: 5038 }];
        return [];
      });

      const compliance = await (service as any).recordCompliance();

      expect(compliance.incomplete).toHaveLength(100);
      // The number the Overview and the Paperwork badge read.
      expect(compliance.incompleteCount).toBe(4800);
    });
  });

  describe('expiring credentials', () => {
    /** A hundred rows that are all already expired — the shape a real backlog takes. */
    const allExpired = cappedRows({ daysToExpiry: -12 });

    it('buckets the whole set, so a backlog cannot hide what is due next month', async () => {
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('COUNT(*) FILTER (WHERE days < 0)')) {
          // What the database really holds behind those hundred rows.
          return [{ expired: 120, within30: 18, within90: 9, within180: 3 }];
        }
        if (sql.includes('LIMIT 100')) return allExpired;
        return [];
      });

      const expiries = await (service as any).expiries();

      expect(expiries.certifications.rows).toHaveLength(100);
      expect(expiries.certifications.expired).toBe(120);
      // The figure that used to read zero because the page was full of expired ones.
      expect(expiries.certifications.within30).toBe(18);
      expect(expiries.documents.within90).toBe(9);
    });
  });

  describe('the onboarding pipeline', () => {
    const pipelineRows = [
      // Working happily for two months. Not waiting for anything.
      { id: 'a1', stage: 'ACTIVE', daysInStage: 60 },
      { id: 'a2', stage: 'ACTIVE', daysInStage: 75 },
      // Genuinely stuck part-way through.
      { id: 'a3', stage: 'TRAINING', daysInStage: 30 },
      // Left, but nobody filled in an exit date — the common case, not a rare one.
      { id: 'a4', stage: 'RESIGNED', daysInStage: 200 },
    ];

    beforeEach(() => {
      query.mockImplementation(async (sql: string) =>
        (sql.includes('daysInStage') ? pipelineRows : []));
    });

    it('does not call a long-serving active assayer stalled', async () => {
      const pipeline = await (service as any).onboardingPipeline();
      const active = pipeline.stages.find((s: any) => s.key === 'ACTIVE');

      expect(active.count).toBe(2);
      // Two months in the job is the goal, not a delay.
      expect(active.stalled).toBe(0);
      expect(active.avgDaysInStage).toBe(0);
    });

    it('still flags someone genuinely stuck part-way through', async () => {
      const pipeline = await (service as any).onboardingPipeline();
      const training = pipeline.stages.find((s: any) => s.key === 'TRAINING');

      expect(training.stalled).toBe(1);
      expect(pipeline.stalled.map((r: any) => r.id)).toEqual(['a3']);
    });

    it('counts only people part-way through as being in onboarding', async () => {
      const pipeline = await (service as any).onboardingPipeline();

      // Not the two ACTIVE, and not the RESIGNED one whose exit date was never captured —
      // that person is reported as exited in the header, and cannot also be onboarding.
      expect(pipeline.inProgress).toBe(1);
    });
  });
});
