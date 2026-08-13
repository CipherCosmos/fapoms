import { Test, TestingModule } from '@nestjs/testing';
import { SlaScannerWorker } from './sla-scanner.worker';
import { AssignmentService } from '../../modules/assignment/assignment.service';
import { HrWorkforceService } from '../../modules/assayer/hr-workforce.service';
import { NotificationDispatchService } from '../../modules/notifications/notification-dispatch.service';
import { DeskEscalationService } from '../../modules/validation/desk-escalation.service';
import { FeedbackEscalationService } from '../../modules/feedback/feedback-escalation.service';
import { LocationTrailService } from '../../modules/assayer/location-trail.service';

/**
 * The scanner runs six independent scans behind one 15-minute tick. The property under test is
 * that they are siblings, not a chain: a failure in one must not stop the others from running.
 *
 * The old code ran them sequentially with every catch re-throwing, so a throw in phase 1 (the
 * assignment SLA scan) aborted desk escalation, feedback escalation and the credential-expiry
 * warnings for that whole tick — and the scan most likely to throw under load was one of the
 * unbounded ones. It also meant a fault in any single scan (including ones still being built)
 * silently starved every scan after it.
 */
describe('SlaScannerWorker phase isolation', () => {
  let worker: SlaScannerWorker;

  const assignmentService = {
    checkSlaBreaches: jest.fn().mockResolvedValue(0),
    autoDeclineExpiredOffers: jest.fn().mockResolvedValue(0),
  };
  const hrWorkforceService = { credentialsExpiringWithin: jest.fn().mockResolvedValue([]) };
  const notificationDispatch = { emitSafe: jest.fn() };
  const deskEscalation = { scan: jest.fn().mockResolvedValue(0) };
  const feedbackEscalation = { scan: jest.fn().mockResolvedValue(0) };
  // Retention is a no-op unless LOCATION_TRAIL_RETENTION_DAYS is configured.
  const locationTrail = { purgeOlderThanRetention: jest.fn().mockResolvedValue({ configured: false, deleted: 0 }) };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SlaScannerWorker,
        { provide: AssignmentService, useValue: assignmentService },
        { provide: HrWorkforceService, useValue: hrWorkforceService },
        { provide: NotificationDispatchService, useValue: notificationDispatch },
        { provide: DeskEscalationService, useValue: deskEscalation },
        { provide: FeedbackEscalationService, useValue: feedbackEscalation },
        { provide: LocationTrailService, useValue: locationTrail },
      ],
    }).compile();
    worker = module.get(SlaScannerWorker);
    jest.clearAllMocks();
    // Silence the expected error logs.
    jest.spyOn((worker as any).logger, 'error').mockImplementation(() => undefined);
    jest.spyOn((worker as any).logger, 'log').mockImplementation(() => undefined);
  });

  const anyJob = {} as any;

  it('runs all six scans when every one succeeds', async () => {
    await worker.runScan(anyJob);

    expect(assignmentService.checkSlaBreaches).toHaveBeenCalledTimes(1);
    expect(assignmentService.autoDeclineExpiredOffers).toHaveBeenCalledTimes(1);
    expect(hrWorkforceService.credentialsExpiringWithin).toHaveBeenCalledTimes(1);
    expect(deskEscalation.scan).toHaveBeenCalledTimes(1);
    expect(feedbackEscalation.scan).toHaveBeenCalledTimes(1);
    expect(locationTrail.purgeOlderThanRetention).toHaveBeenCalledTimes(1);
  });

  it('still runs the later scans when the first phase throws', async () => {
    assignmentService.checkSlaBreaches.mockRejectedValueOnce(new Error('DB blip'));

    await expect(worker.runScan(anyJob)).rejects.toThrow();

    // The point: every later phase ran despite phase 1 failing.
    expect(assignmentService.autoDeclineExpiredOffers).toHaveBeenCalledTimes(1);
    expect(hrWorkforceService.credentialsExpiringWithin).toHaveBeenCalledTimes(1);
    expect(deskEscalation.scan).toHaveBeenCalledTimes(1);
    expect(feedbackEscalation.scan).toHaveBeenCalledTimes(1);
    expect(locationTrail.purgeOlderThanRetention).toHaveBeenCalledTimes(1);
  });

  it('does not let a broken feedback scan starve the assignment scans', async () => {
    // The feedback module is under active construction; a throw there must stay contained.
    feedbackEscalation.scan.mockRejectedValueOnce(new Error('feedback not ready'));

    await expect(worker.runScan(anyJob)).rejects.toThrow();

    expect(assignmentService.checkSlaBreaches).toHaveBeenCalledTimes(1);
    expect(assignmentService.autoDeclineExpiredOffers).toHaveBeenCalledTimes(1);
    expect(deskEscalation.scan).toHaveBeenCalledTimes(1);
  });

  it('reports every failed phase in one aggregate error, so the tick is marked failed and retried', async () => {
    assignmentService.checkSlaBreaches.mockRejectedValueOnce(new Error('a'));
    feedbackEscalation.scan.mockRejectedValueOnce(new Error('b'));

    await worker.runScan(anyJob).then(
      () => { throw new Error('expected runScan to reject'); },
      (err: any) => {
        expect(err).toBeInstanceOf(AggregateError);
        expect(err.errors).toHaveLength(2);
        expect(err.message).toContain('SLA breach scan');
        expect(err.message).toContain('feedback escalation scan');
      },
    );
  });

  it('resolves without throwing when all phases succeed', async () => {
    await expect(worker.runScan(anyJob)).resolves.toBeUndefined();
  });
});
