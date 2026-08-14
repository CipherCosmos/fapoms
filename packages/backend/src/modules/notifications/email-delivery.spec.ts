import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationChannel, NotificationStatus } from '@fapoms/shared';

import { NotificationDeliveryWorker } from './notification-delivery.worker';
import { NotificationEntity } from './notification.entity';
import { DeviceTokenEntity } from './device-token.entity';
import { NotificationPreferenceEntity } from './notification-preference.entity';
import { UserEntity } from '../user/user.entity';
import { FcmProvider } from '../../infrastructure/notifications/fcm-provider';
import { EmailProvider } from '../../infrastructure/notifications/email-provider';
import { NotificationSettingsService } from './notification-settings.service';
import { NotificationSweeper } from './notification.sweeper';

/**
 * The email leg of delivery: staff-only, preference-gated, terminally bookkept.
 *
 * The invariant under test throughout: `email_status` always ends somewhere explicable.
 * A row that never emailed says why (SUPPRESSED + reason), a failure says what happened
 * (FAILED + reason), and nothing is ever double-sent — the whole point of splitting email's
 * lifecycle from the push `status` column.
 */
describe('NotificationDeliveryWorker — deliver-email', () => {
  let worker: NotificationDeliveryWorker;
  let updates: any[];

  /** How many rows the atomic claim reports updating. 0 = another job already owns the row. */
  let claimAffected = 1;
  const notifRepo = {
    findOne: jest.fn(),
    update: jest.fn(async (id: any, patch: any) => { updates.push({ id, ...patch }); return { affected: 1 }; }),
    createQueryBuilder: jest.fn(() => ({
      update: () => ({
        set: (values: any) => {
          updates.push({ id: 'claim', ...values });
          return {
            where: () => ({
              andWhere: () => ({ execute: async () => ({ affected: claimAffected }) }),
            }),
          };
        },
      }),
    })),
  };
  const tokenRepo = { find: jest.fn(), update: jest.fn() };
  const prefRepo = { findOne: jest.fn() };
  const userRepo = { findOne: jest.fn() };
  const fcm = { sendMulticast: jest.fn() };
  const emailProvider = { isEnabled: jest.fn().mockReturnValue(true), send: jest.fn() };
  const sweeper = { requeueStranded: jest.fn(), failAbandonedSends: jest.fn(), requeueStrandedEmails: jest.fn() };

  const emailRow = (over: Partial<NotificationEntity> = {}): Partial<NotificationEntity> => ({
    id: 'n-1',
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
    ({ data: { notificationId: 'n-1' }, attemptsMade: 0, opts: { attempts: 5 }, ...over } as any);

  const lastEmailStatus = () =>
    [...updates].reverse().find((u) => u.emailStatus && u.id !== 'claim')?.emailStatus;
  const lastReason = () => [...updates].reverse().find((u) => u.emailFailureReason !== undefined)?.emailFailureReason;

  beforeEach(async () => {
    updates = [];
    claimAffected = 1;
    jest.clearAllMocks();
    emailProvider.isEnabled.mockReturnValue(true);
    prefRepo.findOne.mockResolvedValue(null);
    userRepo.findOne.mockResolvedValue({ id: 'u-1', email: 'ops@example.in', isActive: true, status: 'ACTIVE' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationDeliveryWorker,
        { provide: getRepositoryToken(NotificationEntity), useValue: notifRepo },
        { provide: getRepositoryToken(DeviceTokenEntity), useValue: tokenRepo },
        { provide: getRepositoryToken(NotificationPreferenceEntity), useValue: prefRepo },
        { provide: getRepositoryToken(UserEntity), useValue: userRepo },
        { provide: FcmProvider, useValue: fcm },
        { provide: EmailProvider, useValue: emailProvider },
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

  it('emails the recipient and settles the row DELIVERED', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());
    emailProvider.send.mockResolvedValue({ success: true, messageId: 'm-1' });

    await worker.deliverEmail(job());

    expect(emailProvider.send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'ops@example.in',
      subject: 'Assignment SLA breached',
    }));
    expect(lastEmailStatus()).toBe(NotificationStatus.DELIVERED);
  });

  it('puts the deep link in the message as an absolute URL', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());
    emailProvider.send.mockResolvedValue({ success: true });

    await worker.deliverEmail(job());

    const payload = emailProvider.send.mock.calls[0][0];
    expect(payload.text).toContain('/assignments?id=asn-1');
    expect(payload.text).toMatch(/https?:\/\//);
  });

  it('does nothing for a row already settled — a duplicate job cannot double-send', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow({ emailStatus: NotificationStatus.DELIVERED }));
    await worker.deliverEmail(job());
    expect(emailProvider.send).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('does nothing for a row that never owed an email', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow({ emailStatus: null }));
    await worker.deliverEmail(job());
    expect(emailProvider.send).not.toHaveBeenCalled();
  });

  it('suppresses, with the reason, for an assayer recipient — email is a staff channel', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow({ userId: null, assayerId: 'as-1' }));
    await worker.deliverEmail(job());
    expect(emailProvider.send).not.toHaveBeenCalled();
    expect(lastEmailStatus()).toBe(NotificationStatus.SUPPRESSED);
    expect(lastReason()).toMatch(/field assayer/);
  });

  it('honours an explicit email opt-out for the category', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());
    prefRepo.findOne.mockResolvedValue({ email: false });
    await worker.deliverEmail(job());
    expect(emailProvider.send).not.toHaveBeenCalled();
    expect(lastEmailStatus()).toBe(NotificationStatus.SUPPRESSED);
  });

  it('treats a missing preference row as opted in — the house convention', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());
    prefRepo.findOne.mockResolvedValue(null);
    emailProvider.send.mockResolvedValue({ success: true });
    await worker.deliverEmail(job());
    expect(emailProvider.send).toHaveBeenCalled();
  });

  it('suppresses rather than erroring when the recipient has no email address', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());
    userRepo.findOne.mockResolvedValue({ id: 'u-1', email: null, isActive: true, status: 'ACTIVE' });
    await worker.deliverEmail(job());
    expect(lastEmailStatus()).toBe(NotificationStatus.SUPPRESSED);
  });

  it('does not email an account suspended since dispatch', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());
    userRepo.findOne.mockResolvedValue({ id: 'u-1', email: 'x@y.in', isActive: true, status: 'SUSPENDED' });
    await worker.deliverEmail(job());
    expect(emailProvider.send).not.toHaveBeenCalled();
    expect(lastEmailStatus()).toBe(NotificationStatus.SUPPRESSED);
  });

  it('fails terminally on a permanent SMTP error instead of burning retries', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());
    emailProvider.send.mockResolvedValue({ success: false, error: 'Invalid login', permanent: true });
    await worker.deliverEmail(job());
    expect(lastEmailStatus()).toBe(NotificationStatus.FAILED);
  });

  it('throws a transient failure back to the queue for backoff', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());
    emailProvider.send.mockResolvedValue({ success: false, error: 'Connection timed out' });
    await expect(worker.deliverEmail(job())).rejects.toThrow('Connection timed out');
    // Recorded, and returned to PENDING rather than settled: the row is unclaimed again so the
    // retry can take it, but it has reached no terminal state.
    expect(lastEmailStatus()).toBe(NotificationStatus.PENDING);
    expect(lastReason()).toBe('Connection timed out');
  });

  it('stops without sending when another job already claimed the row', async () => {
    // The sweeper re-enqueues anything PENDING for five minutes, which a slow fan-out or a
    // throttling provider produces routinely. Two jobs then race; exactly one may send.
    notifRepo.findOne.mockResolvedValue(emailRow());
    claimAffected = 0;

    await worker.deliverEmail(job());

    expect(emailProvider.send).not.toHaveBeenCalled();
  });

  it('releases the claim on a transient failure so the retry can take the row again', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());
    emailProvider.send.mockResolvedValue({ success: false, error: 'Connection timed out' });

    await expect(worker.deliverEmail(job())).rejects.toThrow();

    // Back to PENDING, not left at the SENT the claim set — otherwise the row is stranded
    // until the abandoned-send sweep an hour later.
    expect(lastEmailStatus()).toBe(NotificationStatus.PENDING);
  });

  it('still emails an account locked out by failed sign-ins', async () => {
    // LOCKED is the automatic fifteen-minute lockout, not a severance — and an escalation is
    // if anything more useful to a colleague having a bad morning.
    notifRepo.findOne.mockResolvedValue(emailRow());
    userRepo.findOne.mockResolvedValue({ id: 'u-1', email: 'x@y.in', isActive: true, status: 'LOCKED' });
    emailProvider.send.mockResolvedValue({ success: true });

    await worker.deliverEmail(job());

    expect(emailProvider.send).toHaveBeenCalled();
  });

  it('settles FAILED on the final attempt instead of leaving the row PENDING forever', async () => {
    notifRepo.findOne.mockResolvedValue(emailRow());
    emailProvider.send.mockResolvedValue({ success: false, error: 'Connection timed out' });
    await worker.deliverEmail(job({ attemptsMade: 4 }));
    expect(lastEmailStatus()).toBe(NotificationStatus.FAILED);
    expect(lastReason()).toMatch(/after 5 attempts/);
  });
});
