import { SLAComplianceScoreCalculator } from './recommendation.engine';

/**
 * Owner decision (2026-09-24, E2): an assayer may do several branches in one day. The SLA score
 * used to subtract 20 for two accepted jobs that day and 40 for three (and add 10 for none), so a
 * candidate already working nearby that day was ranked BELOW an idle one. A same-day existing job
 * must not lower the score.
 */
describe('SLA compliance score ignores same-day load', () => {
  const context = (sameDay: Record<string, number>) => ({
    branch: { id: 'b-1', riskScore: 3, latitude: 18.5, longitude: 73.8 },
    client: null,
    scheduledDate: new Date('2026-09-25'),
    weights: {},
    branchFacts: {
      activeWorkloadByAssayer: {}, routeByAssayer: {}, assignmentTotalsByAssayer: {},
      sameDayAcceptedCountByAssayer: sameDay, sameDayBranchPointsByAssayer: {}, priorVisitsByAssayer: {},
      queryCountByAssayer: {}, completedByAssayer: {}, remarksByAssayer: {}, recentOffersByAssayer: {},
      commercialProfilesByAssayer: {}, rules: [], lastAssignment: null,
      projectBranch: null, fairnessOfferCap: 8,
    },
  }) as any;
  // Should the preload be absent, the fallback count must not matter either.
  const count = jest.fn(async () => 3);
  const calc = new SLAComplianceScoreCalculator({ count, find: async () => [] } as any);
  const assayer = { id: 'a-1', performanceRating: 4.0, experienceYears: 5, effectiveLatitude: 18.51, effectiveLongitude: 73.81 } as any;

  it.each([1, 2, 3, 5])('an assayer with %i accepted job(s) that day scores the same as one with none', async (n) => {
    const idle = await calc.calculate(assayer, context({}));
    const busy = await calc.calculate(assayer, context({ 'a-1': n }));
    expect(busy).toBe(idle);
  });

  it('does not query same-day load at all when the preload is missing', async () => {
    const ctx = context({});
    delete ctx.branchFacts;
    await calc.calculate(assayer, ctx);
    expect(count).not.toHaveBeenCalled();
  });
});
