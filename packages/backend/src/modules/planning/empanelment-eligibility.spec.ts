import { EmpanelmentStatus } from '@fapoms/shared';
import { ClientEligibilityFilter } from './recommendation.engine';

/**
 * The truth table of THE per-client gate.
 *
 * The promise: ACTIVE and RECOMMENDED standings qualify; every other standing excludes with the
 * standing named; a person with NO standing recorded is governed by the
 * `planning.eligibility.noEmpanelmentRow` setting (BLOCK by default, ALLOW as the deliberate
 * lenient mode); the client's restricted list beats everything; the bypass escape hatch lets a
 * blocked candidate through but always leaves a trail. No client in context = no gate.
 */
describe('ClientEligibilityFilter — the per-client truth table', () => {
  const makeFilter = (opts: { bypassed?: boolean; policy?: string } = {}) => {
    const noteBypass = jest.fn();
    const settingsGet = jest.fn().mockResolvedValue(opts.policy ?? 'BLOCK');
    const filter = new ClientEligibilityFilter(
      { isBypassedSync: jest.fn().mockReturnValue(opts.bypassed ?? false), noteBypass } as any,
      { get: settingsGet } as any,
    );
    return { filter, noteBypass, settingsGet };
  };

  const assayer = (id: string) => ({ id }) as any;
  const contextWith = (
    standing?: string,
    extra: { restricted?: string[]; policy?: 'BLOCK' | 'ALLOW' } = {},
  ) =>
    ({
      client: { id: 'c-1', clientCode: 'AXIS', name: 'Axis', restrictedAssayers: extra.restricted ?? [] },
      branchFacts: {
        empanelmentStatusByAssayer: standing !== undefined ? { 'a-1': standing } : {},
        ...(extra.policy ? { noEmpanelmentRowPolicy: extra.policy } : {}),
      },
    }) as any;

  it.each([EmpanelmentStatus.ACTIVE, EmpanelmentStatus.RECOMMENDED])(
    '%s qualifies — the candidate passes',
    async (standing) => {
      const { filter } = makeFilter();
      expect(await filter.evaluate(assayer('a-1'), contextWith(standing))).toBe(true);
    },
  );

  it.each([
    EmpanelmentStatus.REJECTED,
    EmpanelmentStatus.TERMINATED,
    EmpanelmentStatus.NOT_RECOMMENDED,
    EmpanelmentStatus.RESIGNED,
    EmpanelmentStatus.INACTIVE,
    EmpanelmentStatus.DOCUMENTS_PENDING,
  ])('%s excludes the candidate — under BOTH no-row policies', async (standing) => {
    const { filter } = makeFilter();
    expect(await filter.evaluate(assayer('a-1'), contextWith(standing))).toBe(false);
    expect(await filter.evaluate(assayer('a-1'), contextWith(standing, { policy: 'ALLOW' }))).toBe(false);
  });

  it('a disqualifying standing names itself in the exclusion reason', async () => {
    const { filter } = makeFilter();
    expect(await filter.exclusionReason(assayer('a-1'), contextWith(EmpanelmentStatus.RESIGNED))).toContain('RESIGNED');
    expect(await filter.exclusionReason(assayer('a-1'), contextWith(EmpanelmentStatus.REJECTED))).toContain(
      'REJECTED by AXIS',
    );
  });

  describe('no empanelment row at all', () => {
    it('BLOCK (the default): excluded, and the reason says how to fix it', async () => {
      const { filter } = makeFilter();
      const ctx = contextWith(undefined, { policy: 'BLOCK' });
      expect(await filter.evaluate(assayer('a-1'), ctx)).toBe(false);
      expect(await filter.exclusionReason(assayer('a-1'), ctx)).toContain('no empanelment record');
    });

    it('ALLOW: an absent record does not exclude', async () => {
      const { filter } = makeFilter();
      expect(await filter.evaluate(assayer('a-1'), contextWith(undefined, { policy: 'ALLOW' }))).toBe(true);
      // and a pool map that simply lacks THIS assayer behaves as "no row" too
      expect(await filter.evaluate(assayer('a-2'), contextWith(EmpanelmentStatus.REJECTED, { policy: 'ALLOW' }))).toBe(true);
    });

    it('falls back to a live settings read when the policy was not preloaded', async () => {
      const { filter, settingsGet } = makeFilter({ policy: 'ALLOW' });
      const ctx = { client: { id: 'c-1', clientCode: 'AXIS' }, branchFacts: { empanelmentStatusByAssayer: {} } } as any;
      expect(await filter.evaluate(assayer('a-1'), ctx)).toBe(true);
      expect(settingsGet).toHaveBeenCalledWith('planning.eligibility.noEmpanelmentRow');
    });
  });

  it("the client's restricted list excludes even an ACTIVE empanelment", async () => {
    const { filter } = makeFilter();
    const ctx = contextWith(EmpanelmentStatus.ACTIVE, { restricted: ['a-1'] });
    expect(await filter.evaluate(assayer('a-1'), ctx)).toBe(false);
    expect(await filter.exclusionReason(assayer('a-1'), ctx)).toContain('restricted list');
  });

  it('the bypass lets a blocked candidate through, and leaves a trail saying exactly why they were blocked', async () => {
    const { filter, noteBypass } = makeFilter({ bypassed: true });
    expect(await filter.evaluate(assayer('a-1'), contextWith(EmpanelmentStatus.REJECTED))).toBe(true);
    expect(noteBypass).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entityId: 'a-1', detail: expect.stringContaining('REJECTED by AXIS') }),
    );
    // no-row under BLOCK is bypassable too — that is what makes bypass a true escape hatch
    expect(await filter.evaluate(assayer('a-1'), contextWith(undefined, { policy: 'BLOCK' }))).toBe(true);
  });

  it('no client in context short-circuits to pass, untouched by standings or settings', async () => {
    const { filter, settingsGet } = makeFilter();
    expect(await filter.evaluate(assayer('a-1'), { client: null } as any)).toBe(true);
    expect(settingsGet).not.toHaveBeenCalled();
  });
});
