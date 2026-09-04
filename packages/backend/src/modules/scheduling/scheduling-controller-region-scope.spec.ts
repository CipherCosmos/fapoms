import { ForbiddenException } from '@nestjs/common';
import { SchedulingController } from './scheduling.controller';

/**
 * The region ceiling on the WRITE must match the READ.
 *
 * `GET /schedules/:id` (findOne) calls `regionGuard.assertScheduleInScope(id, scope)`, but
 * `POST /schedules/:id/transition` did not — so a region-restricted operator refused a read of a
 * schedule in another region could still transition it. CONFIRMED 2026-09-04: a SOUTH-scoped
 * OPERATIONS account got 403 on the read while the transition skipped the region check entirely
 * (its 400 was an incidental state-machine rejection, not a boundary). This pins the parity.
 */
describe('SchedulingController — region ceiling on transition matches findOne', () => {
  const scope = { regions: ['SOUTH'] } as any;

  const schedulingService: any = {
    findOne: jest.fn().mockResolvedValue({ id: 's1', status: 'TENTATIVE' }),
    transition: jest.fn().mockResolvedValue({ id: 's1', status: 'CONFIRMED' }),
  };
  const regionGuard: any = {
    assertScheduleInScope: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new SchedulingController(schedulingService, regionGuard);
  const req = { user: { id: 'op-1', roles: [{ name: 'OPERATIONS' }] } } as any;

  beforeEach(() => jest.clearAllMocks());

  it('asserts the schedule is in scope BEFORE transitioning', async () => {
    await controller.transition('s1', { targetStatus: 'CONFIRMED' } as any, req, scope);
    expect(regionGuard.assertScheduleInScope).toHaveBeenCalledWith('s1', scope);
    expect(schedulingService.transition).toHaveBeenCalled();
  });

  it('a cross-region refusal stops the transition before any state change', async () => {
    regionGuard.assertScheduleInScope.mockRejectedValueOnce(
      new ForbiddenException('That record belongs to a region your account is not assigned to.'),
    );
    await expect(
      controller.transition('s1', { targetStatus: 'CONFIRMED' } as any, req, scope),
    ).rejects.toThrow(ForbiddenException);
    expect(schedulingService.transition).not.toHaveBeenCalled();
  });

  it('findOne (the read) still asserts the same ceiling — parity guard', async () => {
    await controller.findOne('s1', scope, req);
    expect(regionGuard.assertScheduleInScope).toHaveBeenCalledWith('s1', scope);
  });
});
