import {
  PerformanceScoreCalculator,
  SLAComplianceScoreCalculator,
  RiskScoreCalculator,
} from './recommendation.engine';

/**
 * "Nobody has assessed this person" must never read as "this person is excellent".
 *
 * `performance_rating` was NOT NULL DEFAULT 5.00 and no importer wrote it, so all 1,155
 * imported appraisers sat at the top of the scale — and two of the engine's three readers award
 * a bonus at ≥ 4.5 on a HIGH-RISK branch. The people nobody had vetted were therefore
 * preferentially steered to the most sensitive vaults, while the qualification profile shown to
 * partner banks said "no work history yet" about the same person.
 *
 * Migration 1793500000000 makes the column nullable and clears the untouched defaults. These
 * tests pin what null must mean in each of the three places it is read.
 */
describe('an unrated assayer', () => {
  const branch = (riskScore: number) => ({ id: 'b-1', riskScore, latitude: 18.5, longitude: 73.8 }) as any;
  const context = (riskScore: number) => ({
    branch: branch(riskScore),
    client: null,
    scheduledDate: new Date('2026-09-01'),
    weights: {},
    branchFacts: {
      activeWorkloadByAssayer: {}, routeByAssayer: {}, assignmentTotalsByAssayer: {},
      sameDayAcceptedCountByAssayer: {}, sameDayBranchPointsByAssayer: {}, priorVisitsByAssayer: {},
      queryCountByAssayer: {}, completedByAssayer: {}, remarksByAssayer: {}, recentOffersByAssayer: {},
      commercialProfilesByAssayer: {}, doubleBookedByAssayer: {}, rules: [], lastAssignment: null,
      projectBranch: null, fairnessOfferCap: 8,
    },
  }) as any;

  describe('performance dimension', () => {
    const calc = new PerformanceScoreCalculator();

    it('scores neutral, not full marks', async () => {
      await expect(calc.calculate({ performanceRating: null } as any)).resolves.toBe(50);
    });

    it('still reads a real rating exactly — including a genuine zero', async () => {
      await expect(calc.calculate({ performanceRating: 5.0 } as any)).resolves.toBe(100);
      await expect(calc.calculate({ performanceRating: '0.00' } as any)).resolves.toBe(0);
      await expect(calc.calculate({ performanceRating: '4.00' } as any)).resolves.toBe(80);
    });
  });

  describe('high-risk branch gate', () => {
    const calc = new RiskScoreCalculator();

    it('does not clear the seniority bar on an absent rating, however long the tenure', async () => {
      const veteranButUnrated = { performanceRating: null, experienceYears: 20 } as any;
      const score = await calc.calculate(veteranButUnrated, context(9));
      expect(score).toBeLessThan(100);
    });

    it('clears it for someone actually assessed as excellent', async () => {
      const proven = { performanceRating: 4.8, experienceYears: 6 } as any;
      await expect(calc.calculate(proven, context(9))).resolves.toBe(100);
    });

    it('is irrelevant on an ordinary branch — an unrated person is not penalised there', async () => {
      await expect(calc.calculate({ performanceRating: null, experienceYears: 0 } as any, context(3))).resolves.toBe(100);
    });
  });

  describe('SLA compliance dimension', () => {
    // The SLA scorer takes an assignment repository for its history lookups; these cases
    // exercise the branch-risk arithmetic, which reads only the rating and the tenure.
    const calc = new SLAComplianceScoreCalculator({ count: async () => 0, find: async () => [] } as any);

    it('awards no high-reliability bonus to an unrated candidate', async () => {
      const unrated = { id: 'a-1', performanceRating: null, experienceYears: 10 } as any;
      const proven = { id: 'a-2', performanceRating: 4.9, experienceYears: 10 } as any;
      const [unratedScore, provenScore] = await Promise.all([
        calc.calculate(unrated, context(9)),
        calc.calculate(proven, context(9)),
      ]);
      expect(provenScore).toBeGreaterThan(unratedScore);
    });

    it('does not apply the novice PENALTY either — unrated is unknown, not bad', async () => {
      const unratedVeteran = { id: 'a-1', performanceRating: null, experienceYears: 10 } as any;
      const ratedPoorly = { id: 'a-2', performanceRating: 2.0, experienceYears: 10 } as any;
      const [unknown, poor] = await Promise.all([
        calc.calculate(unratedVeteran, context(9)),
        calc.calculate(ratedPoorly, context(9)),
      ]);
      expect(unknown).toBeGreaterThan(poor);
    });
  });
});
