import { ASSIGNMENT_ERROR_CODES } from '@fapoms/shared';
import { AssignmentService } from './assignment.service';
import { ComplianceHoldFilter } from '../planning/recommendation.engine';

/**
 * Held from NEW work on compliance grounds (2026-09-23): an overdue re-check past its grace
 * period, or an adverse re-check awaiting a senior. Refused where work is created, accepted or
 * moved to them — not overridable by a reason — and excluded, with the reason, from the planner.
 */
describe('the compliance hold on new work', () => {
  const held = ['Police verification overdue since 2026-06-15'];

  it('refuses new work with its own code, naming what holds them', async () => {
    const svc: any = Object.create(AssignmentService.prototype);
    svc.compliance = { workBlockers: jest.fn(async () => held) };
    await expect(svc.assertNotComplianceHeld('a-1', 'Ramesh Kumar')).rejects.toMatchObject({
      message: expect.stringMatching(/Ramesh Kumar cannot be given new work: Police verification overdue since 2026-06-15/),
    });
    const err = await svc.assertNotComplianceHeld('a-1', 'Ramesh Kumar').catch((e: any) => e);
    expect(JSON.stringify(err.getResponse())).toContain(ASSIGNMENT_ERROR_CODES.ASSAYER_COMPLIANCE_BLOCKED);
  });

  it('lets somebody with nothing holding them through', async () => {
    const svc: any = Object.create(AssignmentService.prototype);
    svc.compliance = { workBlockers: jest.fn(async () => []) };
    await expect(svc.assertNotComplianceHeld('a-1', 'Ramesh Kumar')).resolves.toBeUndefined();
  });

  it('is asked once per planning run for every candidate, then per candidate from memory', async () => {
    const standingsFor = jest.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { blockers: id === 'a-2' ? held : [] }])));
    const workBlockers = jest.fn();
    const filter = new ComplianceHoldFilter({ standingsFor, workBlockers } as any);
    await filter.prime(['a-1', 'a-2']);

    await expect(filter.evaluate({ id: 'a-1' } as any)).resolves.toBe(true);
    await expect(filter.evaluate({ id: 'a-2' } as any)).resolves.toBe(false);
    await expect(filter.explain({ id: 'a-2' } as any)).resolves.toMatch(/Police verification overdue.*Background tab/);
    expect(standingsFor).toHaveBeenCalledTimes(1);
    expect(workBlockers).not.toHaveBeenCalled();
  });
});
