import { AssignmentService } from './assignment.service';
import { ScheduleStatus } from '@fapoms/shared';

/**
 * Accepting the same assignment a second time.
 *
 * `schedules.assignment_id` is UNIQUE — one calendar entry per assignment, for its whole life.
 * Cancelling an accepted assignment retires that row (`is_active = false`) but KEEPS it, and the
 * re-acceptance guard looked for an *active* row before inserting. The constraint does not care
 * about `is_active`, so the two disagreed and the insert hit the unique index.
 *
 * What that looked like from the desk: assign → accept → cancel → re-offer → accept returned a
 * 500 and the assignment stayed PENDING, unacceptable from either the desk or the phone. It was
 * reported as a negotiation bug because re-offering usually follows a re-negotiation; negotiation
 * is not involved.
 */
describe('AssignmentService.autoScheduleOnAcceptance — re-acceptance', () => {
  const makeService = (existingSchedule: any | null) => {
    const saved: any[] = [];
    const scheduleRepo = {
      findOne: jest.fn().mockResolvedValue(existingSchedule),
      create: jest.fn((x: any) => ({ ...x, id: 'new-schedule' })),
      save: jest.fn(async (x: any) => { saved.push(x); return { id: x.id ?? 'new-schedule', ...x }; }),
    };
    const service = Object.create(AssignmentService.prototype) as AssignmentService;
    (service as any).dataSource = { getRepository: () => scheduleRepo };
    (service as any).auditService = { recordEventSafe: jest.fn() };
    (service as any).notificationDispatch = { emitSafe: jest.fn() };
    (service as any).constraintEvaluator = {
      checkDateAvailability: jest.fn().mockResolvedValue({ passed: true }),
    };
    return { service, scheduleRepo, saved };
  };

  const assignment: any = {
    id: 'asg-1', assignmentNumber: 'A-1', assayerId: 'assayer-2',
    projectId: 'proj-1', scheduledDate: new Date('2026-09-10T00:00:00Z'),
    projectBranch: { branch: { name: 'Test Branch' } },
  };

  const run = (service: AssignmentService) =>
    (service as any).autoScheduleOnAcceptance(assignment, 'user-1', new Date('2026-09-10T00:00:00Z'));

  it('revives the retired row instead of inserting a second one', async () => {
    const retired = {
      id: 'existing-schedule', assignmentId: 'asg-1', assayerId: 'old-assayer',
      // retireSchedule only flips isActive — the row keeps CONFIRMED, which is why an
      // is-it-confirmed check alone would have missed it too.
      isActive: false, status: ScheduleStatus.CONFIRMED,
    };
    const { service, scheduleRepo, saved } = makeService(retired);
    await run(service);

    // The insert path is what violated the unique constraint.
    expect(scheduleRepo.create).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe('existing-schedule');
    expect(saved[0].isActive).toBe(true);
    expect(saved[0].status).toBe(ScheduleStatus.CONFIRMED);
  });

  it('looks the row up by assignment alone, the way the constraint does', async () => {
    const { service, scheduleRepo } = makeService(null);
    await run(service);
    // Filtering on isActive is precisely what let the duplicate insert through.
    expect(scheduleRepo.findOne).toHaveBeenCalledWith({ where: { assignmentId: 'asg-1' } });
  });

  it('re-reads assayer and date from the assignment, since a re-offer can move either', async () => {
    const retired = {
      id: 'existing-schedule', assignmentId: 'asg-1', assayerId: 'old-assayer',
      scheduledDate: new Date('2026-08-01T00:00:00Z'), // retireSchedule only flips isActive — the row keeps CONFIRMED, which is why an
      // is-it-confirmed check alone would have missed it too.
      isActive: false, status: ScheduleStatus.CONFIRMED,
    };
    const { service, saved } = makeService(retired);
    await run(service);

    expect(saved[0].assayerId).toBe('assayer-2');
    expect(saved[0].scheduledDate).toEqual(new Date('2026-09-10T00:00:00Z'));
  });

  it('does nothing when an active confirmed entry already exists', async () => {
    const live = { id: 'existing-schedule', assignmentId: 'asg-1', isActive: true, status: ScheduleStatus.CONFIRMED };
    const { service, saved, scheduleRepo } = makeService(live);
    await run(service);

    expect(saved).toHaveLength(0);
    expect(scheduleRepo.create).not.toHaveBeenCalled();
  });

  it('still creates one for an assignment that has never been scheduled', async () => {
    const { service, scheduleRepo, saved } = makeService(null);
    await run(service);

    expect(scheduleRepo.create).toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    expect(saved[0].status).toBe(ScheduleStatus.CONFIRMED);
  });
});
