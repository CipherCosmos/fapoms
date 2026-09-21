import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationChannel, NotificationStatus } from '@fapoms/shared';

import { NotificationDeliveryWorker } from './notification-delivery.worker';
import { NotificationEntity } from './notification.entity';
import { DeviceTokenEntity } from './device-token.entity';
import { NotificationPreferenceEntity } from './notification-preference.entity';
import { UserEntity } from '../user/user.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { FcmProvider } from '../../infrastructure/notifications/fcm-provider';
import { EmailService } from './email.service';
import { SmsService } from './sms.service';
import { NotificationSettingsService } from './notification-settings.service';
import { NotificationSweeper } from './notification.sweeper';

/**
 * The email leg of delivery: preference-gated, handed to the one mail queue exactly once.
 *
 * The invariant under test throughout: `email_status` always ends somewhere explicable. A row that
 * never emailed says why (SUPPRESSED + reason); a row handed to the mail queue says so (SENT) and
 * the queue writes the outcome back when the email settles (pinned in `outbound-email.spec.ts`);
 * and nothing is ever handed over twice — the whole point of the claim.
 *
 * This job does not send and does not retry a send. It never touches the transport: sending,
 * retrying, "email is not set up" and giving up all belong to `EmailService` / the outbound worker.
 */
describe('NotificationDeliveryWorker — deliver-email', () => {
  let worker: NotificationDeliveryWorker;
  let updates: any[];
  /** Every conditional UPDATE the worker built, with its SET and WHERE terms. */
  let builderCalls: Array<{ set: any; where: Record<string, any>; affected: number }>;
  /** What each conditional UPDATE reports, in order. The first is the claim. Default 1. */
  let affectedQueue: number[];

  const notifRepo = {
    findOne: jest.fn(),
    update: jest.fn(async (id: any, patch: any) => { updates.push({ id, ...patch }); return { affected: 1 }; }),
    createQueryBuilder: jest.fn(() => {
      const call = { set: null as any, where: {} as Record<string, any>, affected: 0 };
      const qb: any = {
        update: () => qb,
        set: (values: any) => { call.set = values; return qb; },
        where: (clause: string, params: any) => { call.where[clause] = params; return qb; },
        andWhere: (clause: string, params: any) => { call.where[clause] = params; return qb; },
        execute: async () => {
          call.affected = affectedQueue.length ? affectedQueue.shift()! : 1;
          builderCalls.push(call);
          return { affected: call.affected };
        },
      };
      return qb;
    }),
  };
  const tokenRepo = { find: jest.fn(), update: jest.fn() };
  const prefRepo = { findOne: jest.fn() };
  const userRepo = { findOne: jest.fn() };
  const assayerRepo = { findOne: jest.fn() };
  const fcm = { sendMulticast: jest.fn(), isEnabled: jest.fn().mockReturnValue(true) };
  const emailService = { queue: jest.fn(), sendNow: jest.fn(), isEnabled: jest.fn().mockReturnValue(true) };
  const sweeper = { requeueStranded: jest.fn(), failAbandonedSends: jest.fn(), requeueStrandedMessages: jest.fn() };

  const NOTIFICATION_ID = '4b3c2d1e-0f9a-4b8c-9d7e-6f5a4b3c2d1e';
  const emailRow = (over: Partial<NotificationEntity> = {}): Partial<NotificationEntity> => ({
    id: NOTIFICATION_ID,
    userId: 'u-1',
    assayerId: null,
    title: 'Assignment SLA breached',
    message: 'ASN-1 is 3h past its response SLA.',
    link: '/assignments?id=asn-1',
    category: 'ASSIGNMENT' as any,
    channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
    status: NotificationStatus.DELIVERED,
    emailStatus: NotificationStatus.PENDING,
    ...over,
  });

  const job = (over: any = {}) =>
    ({ data: { notificationId: NOTIFICATION_ID }, attemptsMade: 0, opts: { attempts: 5 }, ...over } as any);

  const lastEmailStatus = () => [...updates].reverse().find((u) => u.emailStatus)?.emailStatus;
  const lastReason = () => [...updates].reverse().find((u) => u.emailFailureReason !== undefined)?.emailFailureReason;
  const queuedRequest = () => emailService.queue.mock.calls[0]?.[0];
  const claim = () => builderCalls[0];

  beforeEach(async () => {
    updates = [];
    builderCalls = [];
    affectedQueue = [];
    jest.clearAllMocks();
    emailService.queue.mockResolvedValue({ id: 'e-1', status: 'QUEUED', to: 'ops@example.in' });
    prefRepo.findOne.mockResolvedValue(null);
    assayerRepo.findOne.mockResolvedValue(null);
    userRepo.findOne.mockResolvedValue({ id: 'u-1', email: 'ops@example.in', isActive: true, status: 'ACTIVE' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationDeliveryWorker,
        { provide: getRepositoryToken(NotificationEntity), useValue: notifRepo },
        { provide: getRepositoryToken(DeviceTokenEntity), useValue: tokenRepo },
        { provide: getRepositoryToken(NotificationPreferenceEntity), useValue: prefRepo },
        { provide: getRepositoryToken(UserEntity), useValue: userRepo },
        { provide: getRepositoryToken(AssayerEntity), useValue: assayerRepo },
        { provide: FcmProvider, useValue: fcm },
        { provide: EmailService, useValue: emailService },
        // The text leg's hand-off; never reached by these tests, which are about other legs.
        { provide: SmsService, useValue: { queue: jest.fn(), isEnabled: jest.fn().mockReturnValue(true) } },
        {
          provide: NotificationSettingsService,
          // No overrides in tests: resolve straight to the shipped catalog entry.
          useValue: {
            defFor: jest.fn(async (t: string) => {
              const { NOTIFICATION_CATALOG } = require('./notification-catalog');
              const base = NOTIFICATION_CATALOG[t];
              return base ? { ...base, type: t, enabled: true, overridden: [], notes: null } : null;
            }),
            effectiveCatalog: jest.fn(async () => ({})),
          },
        },
        { provide: NotificationSweeper, useValue: sweeper },
      ],
    }).compile();

    worker = module.get(NotificationDeliveryWorker);
  });

  it('hands the email to the mail queue, as a notification email about this notification', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());

    await worker.deliverEmail(job());

    expect(emailService.queue).toHaveBeenCalledTimes(1);
    expect(queuedRequest()).toEqual(expect.objectContaining({
      kind: 'NOTIFICATION',
      to: 'ops@example.in',
      entityType: 'NOTIFICATION',
      entityId: NOTIFICATION_ID,
    }));
    expect(queuedRequest().content.subject).toBe('Assignment SLA breached');
    expect(queuedRequest().content.layout.bodyLines).toEqual(['ASN-1 is 3h past its response SLA.']);
    // It never sends anything itself.
    expect(emailService.sendNow).not.toHaveBeenCalled();
  });

  it('claims the row PENDING → SENT before handing it over, and leaves it SENT — the queue settles it', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());

    await worker.deliverEmail(job());

    expect(claim().where).toEqual({
      'id = :id': { id: NOTIFICATION_ID },
      'email_status = :pending': { pending: NotificationStatus.PENDING },
    });
    expect(claim().set.emailStatus).toBe(NotificationStatus.SENT);
    expect(claim().set.emailedAt).toBeInstanceOf(Date);
    // Claimed first, handed over second: a hand-off with no claim is how a duplicate job doubles it.
    expect(notifRepo.createQueryBuilder.mock.invocationCallOrder[0])
      .toBeLessThan(emailService.queue.mock.invocationCallOrder[0]);
    // Nothing after the hand-off: DELIVERED is the mail queue's to write, once the email went.
    expect(builderCalls).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  it('puts the deep link in the message as an absolute URL', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());

    await worker.deliverEmail(job());

    const { content } = queuedRequest();
    expect(content.text).toContain('/assignments?id=asn-1');
    expect(content.text).toMatch(/https?:\/\//);
    expect(content.layout.linkUrl).toMatch(/^https?:\/\/.*\/assignments\?id=asn-1$/);
  });

  it('carries the badge its type earns — an SLA breach reads as an escalation', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow({ type: 'ASSIGNMENT_SLA_BREACH' }));
    await worker.deliverEmail(job());
    expect(queuedRequest().content.layout.badge).toEqual({ text: 'SLA ESCALATION', tone: 'flame' });
  });

  it('does nothing for a row already handed over or settled — a duplicate job cannot hand it over twice', async () => {
    for (const emailStatus of [NotificationStatus.SENT, NotificationStatus.DELIVERED, NotificationStatus.FAILED]) {
      notifRepo.findOne.mockResolvedValue(emailRow({ emailStatus }));
      await worker.deliverEmail(job());
    }
    expect(emailService.queue).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(builderCalls).toHaveLength(0);
  });

  it('does nothing for a row that never owed an email', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow({ emailStatus: null }));
    await worker.deliverEmail(job());
    expect(emailService.queue).not.toHaveBeenCalled();
  });

  it('stops without handing over when another job already claimed the row', async () => {
    // The sweeper re-enqueues anything PENDING for five minutes, which a slow fan-out produces
    // routinely. Two jobs then race; exactly one may hand the email to the queue.
    notifRepo.findOne.mockResolvedValue(emailRow());
    affectedQueue = [0];

    await worker.deliverEmail(job());

    expect(emailService.queue).not.toHaveBeenCalled();
  });

  it('gives the claim back and throws when the queue did not take it, so Bull tries the hand-off again', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());
    emailService.queue.mockResolvedValue({
      id: null, status: 'NOT_QUEUED', to: 'ops@example.in', error: 'The email could not be queued. Hand the details over another way.',
    });

    await expect(worker.deliverEmail(job())).rejects.toThrow('could not be queued');

    const putBack = builderCalls[1];
    expect(putBack.set).toEqual({
      emailStatus: NotificationStatus.PENDING,
      emailFailureReason: 'The email could not be queued. Hand the details over another way.',
    });
    // Conditional: only a row this job still holds as SENT goes back to PENDING.
    expect(putBack.where).toEqual({
      'id = :id': { id: NOTIFICATION_ID },
      'email_status = :handedOff': { handedOff: NotificationStatus.SENT },
    });
  });

  it('settles FAILED on the last attempt instead of putting it back for the sweeper to re-queue for ever', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());
    emailService.queue.mockResolvedValue({ id: null, status: 'NOT_QUEUED', to: '', error: 'There is no email address to send to.' });

    await expect(worker.deliverEmail(job({ attemptsMade: 4 }))).resolves.toBeUndefined();

    const settle = builderCalls[1];
    expect(settle.set.emailStatus).toBe(NotificationStatus.FAILED);
    expect(settle.set.emailFailureReason).toMatch(/no email address.*after 5 attempts/);
    expect(settle.where['email_status = :handedOff']).toEqual({ handedOff: NotificationStatus.SENT });
  });

  it('emails an assayer recipient when they have an email address on file', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow({ userId: null, assayerId: 'as-1' }));
    assayerRepo.findOne.mockResolvedValue({ id: 'as-1', email: 'assayer@example.in', displayName: 'Raj Assayer', status: 'ACTIVE' });
    await worker.deliverEmail(job());
    expect(queuedRequest()).toEqual(expect.objectContaining({ to: 'assayer@example.in' }));
  });

  it('suppresses, with the reason, when an assayer recipient has no email on file', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow({ userId: null, assayerId: 'as-1' }));
    assayerRepo.findOne.mockResolvedValue({ id: 'as-1', email: null, displayName: 'Raj Assayer', status: 'ACTIVE' });
    await worker.deliverEmail(job());
    expect(emailService.queue).not.toHaveBeenCalled();
    expect(lastEmailStatus()).toBe(NotificationStatus.SUPPRESSED);
    expect(lastReason()).toMatch(/Field assayer has no email address/);
  });

  it('honours an explicit email opt-out for the category', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());
    prefRepo.findOne.mockResolvedValue({ email: false });
    await worker.deliverEmail(job());
    expect(emailService.queue).not.toHaveBeenCalled();
    expect(lastEmailStatus()).toBe(NotificationStatus.SUPPRESSED);
  });

  it('treats a missing preference row as opted in — the house convention', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());
    prefRepo.findOne.mockResolvedValue(null);
    await worker.deliverEmail(job());
    expect(emailService.queue).toHaveBeenCalled();
  });

  it('suppresses rather than erroring when the recipient has no email address', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());
    userRepo.findOne.mockResolvedValue({ id: 'u-1', email: null, isActive: true, status: 'ACTIVE' });
    await worker.deliverEmail(job());
    expect(lastEmailStatus()).toBe(NotificationStatus.SUPPRESSED);
    expect(emailService.queue).not.toHaveBeenCalled();
  });

  it('does not email an account suspended since dispatch', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());
    userRepo.findOne.mockResolvedValue({ id: 'u-1', email: 'x@y.in', isActive: true, status: 'SUSPENDED' });
    await worker.deliverEmail(job());
    expect(emailService.queue).not.toHaveBeenCalled();
    expect(lastEmailStatus()).toBe(NotificationStatus.SUPPRESSED);
  });

  it('still emails an account locked out by failed sign-ins', async () => {
    // LOCKED is the automatic fifteen-minute lockout, not a severance — and an escalation is
    // if anything more useful to a colleague having a bad morning.
    notifRepo.findOne.mockResolvedValue(emailRow());
    userRepo.findOne.mockResolvedValue({ id: 'u-1', email: 'x@y.in', isActive: true, status: 'LOCKED' });

    await worker.deliverEmail(job());

    expect(emailService.queue).toHaveBeenCalled();
  });

  it('does not decide "email is not set up" itself — the sending worker does, and the notification lands SUPPRESSED', async () => {
    // A replica without the credential must not silence a row a configured sender could deliver.
    notifRepo.findOne.mockResolvedValue(emailRow());
    emailService.isEnabled.mockReturnValue(false);

    await worker.deliverEmail(job());

    expect(emailService.queue).toHaveBeenCalled();
    expect(lastEmailStatus()).toBeUndefined();
  });
});
