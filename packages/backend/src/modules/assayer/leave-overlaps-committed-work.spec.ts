import { BadRequestException } from '@nestjs/common';
import { ASSAYER_ERROR_CODES, AssignmentStatus } from '@fapoms/shared';
import { AssayerService } from './assayer.service';
import { COMMITTED_ASSIGNMENT_STATUSES } from '../assignment/assignment-workload';

/**
 * `PUT /assayers/:id` with `leaves` (self-editable from the app's availability screen) was never
 * compared with the assayer's own diary, so an assayer could accept Thursday's branch and then
 * mark Thursday as leave. A NEW leave period that covers a day of accepted work (ACCEPTED,
 * CHECKED_IN, IN_PROGRESS) is now refused, naming the date and branch — for the assayer's own
 * edits only; staff may record it and then reassign (owner decision 2026-09-24).
 */
describe('leave may not cover accepted work', () => {
  const ASSAYER = 'asr-1';

  const build = (held: Array<{ assignment_number: string; scheduled_on: string; branch_name: string }>, stored: any[] = []) => {
    const svc: any = Object.create(AssayerService.prototype);
    svc.dataSource = { query: jest.fn(async () => held) };
    svc.findOne = jest.fn(async () => ({ id: ASSAYER, leaves: stored }));
    svc.assayerRepository = { save: jest.fn(async (a: any) => a), metadata: { findColumnWithPropertyName: () => undefined } };
    return svc;
  };

  const thursday = [{ assignment_number: 'ASN-0042', scheduled_on: '2026-10-01', branch_name: 'Thrissur Main' }];

  it('refuses a new leave covering an accepted day, naming the date and the branch, before anything is saved', async () => {
    const svc = build(thursday);
    const err = await svc
      .update(ASSAYER, { leaves: [{ startDate: '2026-09-30', endDate: '2026-10-02' }] } as any, ASSAYER, { selfEdit: true })
      .catch((e: any) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain('Thrissur Main');
    expect(err.message).toContain('ASN-0042');
    expect(err.message).toMatch(/01 Oct 2026/);
    expect(err.code ?? err.getResponse?.().code).toBe(ASSAYER_ERROR_CODES.LEAVE_OVERLAPS_ASSIGNED_WORK);
    expect(svc.assayerRepository.save).not.toHaveBeenCalled();
  });

  it('lets STAFF record the same overlapping leave — never refused on the leave', async () => {
    const svc = build(thursday);
    const err = await svc
      .update(ASSAYER, { leaves: [{ startDate: '2026-09-30', endDate: '2026-10-02' }] } as any, 'hr-1', { selfEdit: false })
      .catch((e: any) => e);
    // Whatever else this minimal harness trips on, it is not the leave rule.
    expect(err?.code ?? err?.getResponse?.()?.code).not.toBe(ASSAYER_ERROR_CODES.LEAVE_OVERLAPS_ASSIGNED_WORK);
  });

  /** B12 (2026-09-24): HR is told which accepted jobs the leave covers — a warning, not a refusal. */
  it('warns STAFF, listing the accepted jobs the new leave covers', async () => {
    const svc = build(thursday);
    const warning = await svc.leaveOverCommittedWorkWarning(ASSAYER, [], [{ startDate: '2026-09-30', endDate: '2026-10-02' }]);
    expect(warning).toMatchObject({
      code: ASSAYER_ERROR_CODES.LEAVE_OVERLAPS_ASSIGNED_WORK,
      assignments: [{ assignmentNumber: 'ASN-0042', day: '2026-10-01', branchName: 'Thrissur Main' }],
    });
    expect(warning.message).toMatch(/Leave saved, but it covers work .*01 Oct 2026 at Thrissur Main \(ASN-0042\)/);
    expect(await build(thursday).leaveOverCommittedWorkWarning(ASSAYER, [], [{ startDate: '2026-10-05', endDate: '2026-10-06' }])).toBeNull();
  });

  it('the staff update carries the warning on its response', async () => {
    const svc = build(thursday);
    svc.leaveOverCommittedWorkWarning = jest.fn(async () => ({ code: 'X', message: 'm', assignments: [] }));
    await svc.update(ASSAYER, { leaves: [{ startDate: '2026-09-30', endDate: '2026-10-02' }] } as any, 'hr-1').catch(() => undefined);
    expect(svc.leaveOverCommittedWorkWarning).toHaveBeenCalledWith(ASSAYER, [], [{ startDate: '2026-09-30', endDate: '2026-10-02' }]);
  });

  it('the controller marks an assayer principal as a self-edit and staff as not', async () => {
    const { AssayerController } = await import('./assayer.controller');
    const c: any = Object.create(AssayerController.prototype);
    c.regionGuard = { assertAssayerInScope: jest.fn(async () => undefined) };
    c.assayerService = { update: jest.fn(async () => ({ id: ASSAYER })) };
    const dto = { leaves: [{ startDate: '2026-10-01', endDate: '2026-10-01' }] };
    await c.update(ASSAYER, dto, { user: { id: ASSAYER, roles: [{ name: 'ASSAYER' }] } });
    expect(c.assayerService.update).toHaveBeenLastCalledWith(ASSAYER, dto, ASSAYER, { selfEdit: true });
    await c.update(ASSAYER, dto, { user: { id: '22222222-2222-4222-8222-222222222222', roles: [{ name: 'OPERATIONS' }] } });
    expect(c.assayerService.update).toHaveBeenLastCalledWith(ASSAYER, dto, '22222222-2222-4222-8222-222222222222', { selfEdit: false });
  });

  it('asks only about committed work — the shared set, not PENDING offers or finished jobs', async () => {
    const svc = build([]);
    await svc['assertLeaveClearOfCommittedWork'](ASSAYER, [], [{ startDate: '2026-10-01', endDate: '2026-10-01' }]);
    const [sql, params] = svc.dataSource.query.mock.calls[0];
    expect(sql).toMatch(/assayer_id = \$1/);
    expect(params).toEqual([ASSAYER, COMMITTED_ASSIGNMENT_STATUSES.map(String)]);
    expect(params[1]).not.toContain(AssignmentStatus.PENDING);
    expect(params[1]).not.toContain(AssignmentStatus.COMPLETED);
  });

  it('treats both ends as inclusive: a single-day leave on the day itself is refused', async () => {
    const svc = build(thursday);
    await expect(
      svc['assertLeaveClearOfCommittedWork'](ASSAYER, [], [{ startDate: '2026-10-01', endDate: '2026-10-01' }]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reads a timestamp-form leave date as the IST business day, not the UTC one', async () => {
    // 2026-09-30T18:30:00Z is midnight on 1 October in India — the accepted day.
    const svc = build(thursday);
    await expect(
      svc['assertLeaveClearOfCommittedWork'](ASSAYER, [], [{ startDate: '2026-09-30T18:30:00.000Z', endDate: '2026-09-30T18:30:00.000Z' }]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows leave on days with no accepted work', async () => {
    const svc = build(thursday);
    await expect(
      svc['assertLeaveClearOfCommittedWork'](ASSAYER, [], [{ startDate: '2026-10-02', endDate: '2026-10-05' }]),
    ).resolves.toBeUndefined();
  });

  it('does not re-judge a period already on the record, so an old overlap cannot block editing the list', async () => {
    const existing = { startDate: '2026-10-01', endDate: '2026-10-01' };
    const svc = build(thursday);
    await expect(
      svc['assertLeaveClearOfCommittedWork'](ASSAYER, [existing], [existing, { startDate: '2026-11-10', endDate: '2026-11-11' }]),
    ).resolves.toBeUndefined();
  });

  it('asks nothing when the request only removes leave', async () => {
    const svc = build(thursday);
    await svc['assertLeaveClearOfCommittedWork'](ASSAYER, [{ startDate: '2026-10-01', endDate: '2026-10-01' }], []);
    expect(svc.dataSource.query).not.toHaveBeenCalled();
  });
});
