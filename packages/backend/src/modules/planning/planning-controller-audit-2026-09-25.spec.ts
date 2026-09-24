import { PlanningController } from './planning.controller';

/**
 * The request edge of the 2026-09-25 planning audit:
 *
 *  F19 the saved coverage-plan version is generated under the SAME scope as the preview — it was
 *      generated unscoped, so a regional planner previewed their region and saved the whole project;
 *  F1  both carry the campaign start date the modal collected;
 *  F9  the candidate list says how many were ranked when it returns only the top N;
 *      and the candidate list is asked for the project being planned.
 */
const make = () => {
  const c: any = Object.create(PlanningController.prototype);
  c.regionGuard = { assertProjectInScope: jest.fn(async () => undefined), assertBranchInScope: jest.fn(async () => undefined) };
  c.operationsPlanningService = { createOrRegeneratePlan: jest.fn(async () => ({ id: 'plan-1' })) };
  c.planningWriteJobs = { enqueueGenerateVersion: jest.fn(async () => ({ jobId: 'j-1' })) };
  c.planningJobsService = { enqueueCoveragePlan: jest.fn(async () => ({ jobId: 'j-2' })) };
  c.planningService = {
    getRecommendedCandidates: jest.fn(async () => Object.assign([{ id: 'a-1' }], { excluded: [], candidateTotal: 240 })),
  };
  return c;
};
const req = { user: { id: 'ops-1', roles: ['OPERATIONS'], regions: ['WEST'] } };
const scope = { regions: ['WEST'] } as any;

describe('PlanningController — audit 2026-09-25', () => {
  it('F19/F1: the synchronous version is generated with the caller\'s scope and start date', async () => {
    const c = make();
    await c.createOrRegeneratePlan('p-1', { overrides: [], justification: 'x', startDate: '2026-10-05' }, req, scope);
    expect(c.operationsPlanningService.createOrRegeneratePlan).toHaveBeenCalledWith(
      'p-1', [], 'ops-1', 'x', undefined, { scope, startDate: '2026-10-05' },
    );
  });

  it('F19/F1: the queued version carries the same scope and start date', async () => {
    const c = make();
    await c.queueCreateOrRegeneratePlan('p-1', { overrides: [], startDate: '2026-10-05' }, req, scope);
    const call = c.planningWriteJobs.enqueueGenerateVersion.mock.calls[0];
    expect(call[4]).toEqual({ scope, startDate: '2026-10-05' });
  });

  it('F1: the preview job carries the start date', async () => {
    const c = make();
    await c.queueProjectCoveragePlan('p-1', req, scope, { startDate: '2026-10-05' });
    expect(c.planningJobsService.enqueueCoveragePlan).toHaveBeenCalledWith('p-1', scope, 'ops-1', '2026-10-05');
  });

  it('F9: says how many candidates were ranked beside the capped list, and passes the project', async () => {
    const c = make();
    const pid = '11111111-2222-3333-4444-555555555555';
    const res = await c.getRecommendations('b-1', '2026-10-05', undefined, undefined, undefined, undefined, scope, pid);
    expect(res.meta).toMatchObject({ candidateTotal: 240, shown: 1 });
    expect(c.planningService.getRecommendedCandidates.mock.calls[0][3]).toMatchObject({ projectId: pid });
  });
});
