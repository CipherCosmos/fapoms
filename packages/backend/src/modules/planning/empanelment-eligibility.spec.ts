import { ClientEligibilityFilter } from './recommendation.engine';

/**
 * The empanelment wiring into planning — pinned separately because it is a behaviour change.
 *
 * The promise: only a client's explicitly recorded "no" (REJECTED / TERMINATED /
 * NOT_RECOMMENDED) removes a candidate; every other standing, and the total absence of a row,
 * behaves exactly as before this wiring existed. The bypass escape hatch still works and is
 * noted, so an operator who overrides it leaves a trail.
 */
describe('ClientEligibilityFilter — empanelment standing', () => {
  const makeFilter = (bypassed = false) => {
    const noteBypass = jest.fn();
    const filter = new ClientEligibilityFilter({
      isBypassedSync: jest.fn().mockReturnValue(bypassed),
      noteBypass,
    } as any);
    return { filter, noteBypass };
  };

  const assayer = (id: string) => ({ id, eligibleClients: [] }) as any;
  const contextWith = (standing?: string) => ({
    client: { id: 'c-1', clientCode: 'AXIS', name: 'Axis' },
    branchFacts: standing !== undefined ? { empanelmentStatusByAssayer: { 'a-1': standing } } : {},
  }) as any;

  it.each(['REJECTED', 'TERMINATED', 'NOT_RECOMMENDED'])('%s excludes the candidate', async (standing) => {
    const { filter } = makeFilter();
    expect(await filter.evaluate(assayer('a-1'), contextWith(standing))).toBe(false);
  });

  it.each(['ACTIVE', 'RECOMMENDED', 'DOCUMENTS_PENDING', 'RESIGNED', 'INACTIVE'])(
    '%s decides nothing — the legacy check (which passes by default) proceeds',
    async (standing) => {
      const { filter } = makeFilter();
      expect(await filter.evaluate(assayer('a-1'), contextWith(standing))).toBe(true);
    },
  );

  it('no empanelment row at all behaves exactly as before the wiring', async () => {
    const { filter } = makeFilter();
    expect(await filter.evaluate(assayer('a-1'), contextWith(undefined))).toBe(true);
    // and a pool map that simply lacks this assayer
    const ctx = contextWith('REJECTED');
    expect(await filter.evaluate(assayer('a-2'), ctx)).toBe(true);
  });

  it('the bypass lets a negative standing through, and leaves a trail saying so', async () => {
    const { filter, noteBypass } = makeFilter(true);
    expect(await filter.evaluate(assayer('a-1'), contextWith('REJECTED'))).toBe(true);
    expect(noteBypass).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entityId: 'a-1',
      detail: expect.stringContaining('empanelment REJECTED by AXIS'),
    }));
  });

  it('no client in context short-circuits to pass, untouched by standings', async () => {
    const { filter } = makeFilter();
    expect(await filter.evaluate(assayer('a-1'), { client: null } as any)).toBe(true);
  });
});
