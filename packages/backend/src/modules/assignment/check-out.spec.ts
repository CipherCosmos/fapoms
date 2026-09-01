import { AssignmentService } from './assignment.service';
import { LocationPingSource } from '../assayer/assayer-location-ping.entity';

/**
 * Leaving the branch.
 *
 * `check-in` recorded the one moment the platform knows for certain that an assayer was at a
 * branch, and nothing recorded when they left — so attendance evidence was a start with no end.
 * Time on site could not be stated, a visit abandoned after ten minutes looked identical to a
 * full day's audit, and the return journey had no start point for travel assessment to measure.
 *
 * The rules that matter are about what this must NOT do: it must not complete the assignment,
 * must not move a departure already recorded, and must not be refusable on distance.
 */
describe('AssignmentService.recordCheckOut', () => {
  const BRANCH = { latitude: 18.5204, longitude: 73.8567 }; // Pune
  const ASSAYER = 'assayer-1';

  const makeService = (overrides: Record<string, any> = {}) => {
    const assignment: any = {
      id: 'asg-1',
      assayerId: ASSAYER,
      status: 'CHECKED_IN',
      checkedInAt: new Date('2026-09-01T04:00:00Z'),
      checkedOutAt: null,
      syncToken: 'SYNC-1',
      projectBranch: { branch: BRANCH },
      assayer: { displayName: 'Test Assayer' },
      ...overrides,
    };

    const service = Object.create(AssignmentService.prototype) as AssignmentService;
    (service as any).findOne = jest.fn().mockResolvedValue(assignment);
    (service as any).assignmentRepository = { save: jest.fn(async (a: any) => a) };
    (service as any).dataSource = { getRepository: () => ({ findOne: jest.fn().mockResolvedValue(null) }) };
    (service as any).locationTrail = { record: jest.fn().mockResolvedValue(undefined) };
    (service as any).auditService = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    return { service, assignment };
  };

  it('records when and where they left', async () => {
    const { service, assignment } = makeService();
    const res = await service.recordCheckOut('asg-1', 18.5205, 73.8568, undefined, ASSAYER, 12);

    expect(res.success).toBe(true);
    expect(assignment.checkedOutAt).toBeInstanceOf(Date);
    expect(assignment.checkOutLatitude).toBe(18.5205);
    expect(assignment.checkOutLongitude).toBe(73.8568);
    expect(assignment.checkOutAccuracyMeters).toBe(12);
  });

  /**
   * The central design decision. Leaving the branch and finishing the audit are different facts:
   * completion is evidenced by paperwork that arrives later, so auto-completing here would mark
   * work done because somebody walked out of a building.
   */
  it('does NOT complete the assignment or otherwise change its status', async () => {
    const { service, assignment } = makeService();
    await service.recordCheckOut('asg-1', 18.5205, 73.8568, undefined, ASSAYER);
    expect(assignment.status).toBe('CHECKED_IN');
  });

  it('refuses a check-out with no check-in — there is no window to close', async () => {
    const { service } = makeService({ checkedInAt: null });
    const res = await service.recordCheckOut('asg-1', 18.5205, 73.8568, undefined, ASSAYER);
    expect(res.success).toBe(false);
    expect(res.error).toBe('NOT_CHECKED_IN');
  });

  it('refuses someone else’s assignment', async () => {
    const { service } = makeService();
    const res = await service.recordCheckOut('asg-1', 18.5205, 73.8568, undefined, 'someone-else');
    expect(res.success).toBe(false);
    expect(res.error).toBe('NOT_YOUR_ASSIGNMENT');
  });

  /**
   * A retry after a response that never arrived must not be punished, and must not rewrite the
   * record — otherwise a second tap silently extends the recorded visit.
   */
  it('keeps the first departure and reports success on a repeat', async () => {
    const already = new Date('2026-09-01T09:30:00Z');
    const { service, assignment } = makeService({ checkedOutAt: already });
    const res = await service.recordCheckOut('asg-1', 19.9, 74.9, undefined, ASSAYER);

    expect(res.success).toBe(true);
    expect(assignment.checkedOutAt).toBe(already);
    expect((service as any).assignmentRepository.save).not.toHaveBeenCalled();
  });

  it('refuses a stale syncToken rather than overwriting a changed record', async () => {
    const { service } = makeService();
    const res = await service.recordCheckOut('asg-1', 18.52, 73.85, 'SYNC-OLD', ASSAYER);
    expect(res.success).toBe(false);
    expect(res.error).toBe('CONFLICT_ASSIGNMENT_MODIFIED');
  });

  /**
   * Unlike check-in, distance is evidence and never a veto. Check-in must be at the branch or it
   * is not proof of arrival; a departure is by definition the moment of leaving, and someone who
   * has reached their vehicle is not lying. Blocking has no upside — they have already gone — and
   * would leave an assayer unable to close the visit at all.
   */
  it('records a distant departure rather than refusing it', async () => {
    const { service, assignment } = makeService();
    const res = await service.recordCheckOut('asg-1', 19.9975, 73.7898, undefined, ASSAYER); // Nashik

    expect(res.success).toBe(true);
    expect(assignment.checkOutDistanceMeters).toBeGreaterThan(100_000);
  });

  it('puts the departure fix in the movement trail, so the journey home has a start point', async () => {
    const { service } = makeService();
    await service.recordCheckOut('asg-1', 18.5205, 73.8568, undefined, ASSAYER);

    expect((service as any).locationTrail.record).toHaveBeenCalledWith(
      ASSAYER, 18.5205, 73.8568,
      expect.objectContaining({ source: LocationPingSource.CHECK_OUT, assignmentId: 'asg-1' }),
    );
  });

  it('still records the departure when the trail write fails', async () => {
    const { service, assignment } = makeService();
    (service as any).locationTrail.record = jest.fn().mockRejectedValue(new Error('trail down'));
    const res = await service.recordCheckOut('asg-1', 18.5205, 73.8568, undefined, ASSAYER);

    expect(res.success).toBe(true);
    expect(assignment.checkedOutAt).toBeInstanceOf(Date);
  });

  it('leaves distance null when the branch has no coordinates', async () => {
    const { service, assignment } = makeService({ projectBranch: { branch: { latitude: null, longitude: null } } });
    const res = await service.recordCheckOut('asg-1', 18.52, 73.85, undefined, ASSAYER);

    expect(res.success).toBe(true);
    expect(assignment.checkOutDistanceMeters).toBeNull();
  });
});
