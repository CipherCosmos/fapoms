import {
  identityVerificationScore,
  payabilityScore,
  backgroundCheckScore,
  referencesScore,
  credentialsScore,
  trackRecordScore,
  partnerRequirementsScore,
  overallScore,
  applyStandingCap,
  defaultWeights,
} from './qualification-score.contract';
import { BackgroundCheckVerdict, RiskGrade, EmpanelmentStatus, maskTail, QUALIFICATION_DIMENSIONS } from '@fapoms/shared';

/**
 * The pin tests for the qualification formulas.
 *
 * Every boundary asserted here is a promise to whoever reads a score on a profile or a
 * printed export: change a formula and this file fails, which is the intended cost — the
 * numbers on partner-facing paper must not drift as a side effect of a refactor.
 */
describe('qualification score contract', () => {
  const NOW = new Date('2026-08-29T12:00:00Z');

  describe('identityVerification', () => {
    const doc = (over: Partial<any>) => ({
      identity: true, id: 'row-1', label: 'PAN card', verificationStatus: null, expiryDate: null, ...over,
    });

    it('scores 100 when everything on file is verified and unexpired', () => {
      const r = identityVerificationScore([doc({ verificationStatus: 'VERIFIED' }), doc({ id: 'row-2', label: 'Aadhaar front', verificationStatus: 'VERIFIED' })], NOW);
      expect(r.score).toBe(100);
    });

    it('is null — not zero — when nothing is on file: unvetted is unknown, not disqualified', () => {
      const r = identityVerificationScore([doc({ id: null })], NOW);
      expect(r.score).toBeNull();
      expect(r.basis[0]).toMatch(/No identity documents/);
    });

    it('averages only over documents ON FILE — the eight identity types are alternatives', () => {
      // One verified doc + seven absent requirements: the absent ones must not drag the mean.
      const rows = [doc({ verificationStatus: 'VERIFIED' }), ...Array.from({ length: 7 }, (_, i) => doc({ id: null, label: `alt-${i}` }))];
      expect(identityVerificationScore(rows, NOW).score).toBe(100);
    });

    it('pending = 50, rejected = 0, verified-but-expired = 50', () => {
      expect(identityVerificationScore([doc({})], NOW).score).toBe(50);
      expect(identityVerificationScore([doc({ verificationStatus: 'REJECTED' })], NOW).score).toBe(0);
      expect(identityVerificationScore([doc({ verificationStatus: 'VERIFIED', expiryDate: '2020-01-01' })], NOW).score).toBe(50);
    });
  });

  describe('payability', () => {
    const complete = {
      phone: '9999999999', panNumber: 'ABCDE1234F', bankAccountNumber: '123', ifscCode: 'HDFC0000001',
      joiningDate: '2024-01-01', emergencyContactPhone: '8888888888', latitude: 19.1,
    };

    it('scores 100 with every critical field present, and never returns null', () => {
      expect(payabilityScore(complete).score).toBe(100);
      expect(payabilityScore({}).score).toBe(0);
    });

    it('drops proportionally and names what each gap blocks', () => {
      const r = payabilityScore({ ...complete, bankAccountNumber: '', ifscCode: null });
      expect(r.score).toBeCloseTo((100 * 5) / 7, 0);
      expect(r.basis.join(' ')).toMatch(/payouts/);
    });
  });

  describe('backgroundCheck', () => {
    const check = (over: Partial<any>) => ({
      verdict: BackgroundCheckVerdict.CLEAR, riskGrade: RiskGrade.LOW, cibilBand: null, cibilScore: null,
      checkedOn: '2026-06-01', ...over,
    });

    it('CLEAR + LOW risk, recent = 100', () => {
      expect(backgroundCheckScore(check({}), 24, NOW).score).toBe(100);
    });

    it('risk grade discounts: CLEAR + HIGH = 70; clamps at zero: ADVERSE + VERY_HIGH = 0', () => {
      expect(backgroundCheckScore(check({ riskGrade: RiskGrade.HIGH }), 24, NOW).score).toBe(70);
      expect(backgroundCheckScore(check({ verdict: BackgroundCheckVerdict.ADVERSE_FINDING, riskGrade: RiskGrade.VERY_HIGH }), 24, NOW).score).toBe(0);
    });

    it('CRIMINAL_CASE = 0 regardless of freshness', () => {
      expect(backgroundCheckScore(check({ verdict: BackgroundCheckVerdict.CRIMINAL_CASE }), 24, NOW).score).toBe(0);
    });

    it('a stale check is halved and says so', () => {
      const r = backgroundCheckScore(check({ checkedOn: '2023-01-01' }), 24, NOW);
      expect(r.score).toBe(50);
      expect(r.basis.join(' ')).toMatch(/stale/);
    });

    it('no check, or NOT_CHECKED, is null — and CIBIL informs but never scores', () => {
      expect(backgroundCheckScore(null, 24, NOW).score).toBeNull();
      expect(backgroundCheckScore(check({ verdict: BackgroundCheckVerdict.NOT_CHECKED }), 24, NOW).score).toBeNull();
      const withCibil = backgroundCheckScore(check({ cibilBand: 'POOR', cibilScore: 580 }), 24, NOW);
      expect(withCibil.score).toBe(100); // POOR band did not move the number
      expect(withCibil.basis.join(' ')).toMatch(/not scored/);
    });
  });

  describe('references', () => {
    it('none on file = null; recorded-but-never-called counts for nothing', () => {
      expect(referencesScore([]).score).toBeNull();
      expect(referencesScore([{ fullName: 'A', checkedAt: null }]).score).toBe(0);
    });

    it('one checked = 50, two checked = 100, more than two stays 100', () => {
      const checked = { fullName: 'A', checkedAt: '2026-01-01' };
      expect(referencesScore([checked]).score).toBe(50);
      expect(referencesScore([checked, checked]).score).toBe(100);
      expect(referencesScore([checked, checked, checked]).score).toBe(100);
    });
  });

  describe('credentials', () => {
    it('nothing recorded = null', () => {
      expect(credentialsScore([], NOW).score).toBeNull();
    });

    it('skills breadth caps at five; an expired certification counts against currency', () => {
      const skills = Array.from({ length: 6 }, (_, i) => ({ type: 'SKILL', name: `s${i}`, expiryDate: null }));
      expect(credentialsScore(skills, NOW).score).toBe(100);
      const r = credentialsScore([
        { type: 'CERTIFICATION', name: 'valid', expiryDate: '2027-01-01' },
        { type: 'CERTIFICATION', name: 'lapsed', expiryDate: '2025-01-01' },
      ], NOW);
      expect(r.score).toBe(50);
      expect(r.basis.join(' ')).toMatch(/lapsed/);
    });
  });

  describe('trackRecord', () => {
    it('zero assignments = null — the flattering column defaults must not leak through', () => {
      expect(trackRecordScore({ totalAssignments: 0, completedAssignments: 0, onTimeCompletions: 0, acceptanceRate: 100, remarkSummary: null }).score).toBeNull();
    });

    it('averages the signals that exist and skips remarks when nothing is rated', () => {
      const r = trackRecordScore({
        totalAssignments: 10, completedAssignments: 8, onTimeCompletions: 6,
        acceptanceRate: 90, remarkSummary: { count: 0, weightedMean: null, latest: null },
      });
      // completion 80, on-time 75, acceptance 90 → 81.7; remarks skipped
      expect(r.score).toBe(81.7);
    });
  });

  describe('partnerRequirements', () => {
    it('a partner listing nothing has expressed nothing: null, not a free 100', () => {
      expect(partnerRequirementsScore({ skills: [], certifications: [] }, { skills: ['x'], certifications: [] }).score).toBeNull();
    });

    it('matches case-insensitively and names every missing requirement', () => {
      const r = partnerRequirementsScore(
        { skills: ['Gold Appraisal', 'Vault Audit'], certifications: ['BIS Cert'] },
        { skills: ['gold appraisal'], certifications: [] },
      );
      expect(r.score).toBe(33.3);
      expect(r.basis.filter((b) => b.startsWith('Missing'))).toHaveLength(2);
    });
  });

  describe('overall aggregation', () => {
    it('skips nulls and re-normalizes over the dimensions present', () => {
      const score = overallScore(
        [
          { key: 'identityVerification', score: 100 },
          { key: 'backgroundCheck', score: null },
          { key: 'payability', score: 50 },
        ],
        { identityVerification: 20, backgroundCheck: 25, payability: 20 },
      );
      expect(score).toBe(75); // (100×20 + 50×20) / 40 — the null 25-weight vanished
    });

    it('is null when every dimension is null: no number is honest, a made-up one is not', () => {
      expect(overallScore([{ key: 'references', score: null }], defaultWeights())).toBeNull();
    });

    it('every declared dimension carries a default weight — the vocabulary cannot outgrow the weights', () => {
      const w = defaultWeights();
      for (const d of QUALIFICATION_DIMENSIONS) expect(w[d.key]).toBeGreaterThan(0);
    });
  });

  describe('standing caps', () => {
    it('REJECTED caps at 25 as a ceiling, never a floor', () => {
      expect(applyStandingCap(90, EmpanelmentStatus.REJECTED)).toEqual({ effective: 25, cap: 25 });
      expect(applyStandingCap(10, EmpanelmentStatus.REJECTED)).toEqual({ effective: 10, cap: 25 });
    });

    it('ACTIVE/RECOMMENDED/no standing change nothing; null score passes through', () => {
      expect(applyStandingCap(90, EmpanelmentStatus.ACTIVE)).toEqual({ effective: 90, cap: null });
      expect(applyStandingCap(90, null)).toEqual({ effective: 90, cap: null });
      expect(applyStandingCap(null, EmpanelmentStatus.REJECTED)).toEqual({ effective: null, cap: null });
    });

    it('DOCUMENTS_PENDING caps at 69, RESIGNED/INACTIVE at 49', () => {
      expect(applyStandingCap(100, EmpanelmentStatus.DOCUMENTS_PENDING).effective).toBe(69);
      expect(applyStandingCap(100, EmpanelmentStatus.RESIGNED).effective).toBe(49);
      expect(applyStandingCap(100, EmpanelmentStatus.INACTIVE).effective).toBe(49);
    });
  });

  describe('maskTail — the promise on printed paper', () => {
    it('keeps only the last four characters', () => {
      expect(maskTail('ABCDE1234F')).toBe('******234F');
      expect(maskTail('123456789012')).toBe('********9012');
    });

    it('blank in, blank out — a missing number prints as missing, not as stars', () => {
      expect(maskTail(null)).toBe('');
      expect(maskTail('')).toBe('');
      expect(maskTail('  ')).toBe('');
    });

    it('never reveals a short value entirely', () => {
      expect(maskTail('abc')).toBe('***');
    });
  });
});
