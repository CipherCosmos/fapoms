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
 * The text leg of delivery — the SMS twin of `email-delivery.spec.ts`, pinned on the same terms.
 *
 * The invariant throughout: `sms_status` always ends somewhere explicable. A row that never texted
 * says why (SUPPRESSED + reason); a row handed to the SMS queue says so (SENT) and the queue writes
 * the outcome back when the text settles (pinned in `outbound-message.spec.ts`); nothing is handed
 * over twice; and nothing here ever touches the email columns — the two legs share a routine, not a
 * column, and a shared column is how one channel settling once silently dropped another.
 *
 * Only reachable for an event an administrator has switched SMS on for — no shipped event carries
 * it (pinned in `notification-dispatch.service.spec.ts`). This job does not send and does not retry
 * a send; that is `SmsService.queue` → `OutboundSmsWorker`.
 */
describe('NotificationDeliveryWorker — deliver-sms', () => {
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
  const smsService = { queue: jest.fn(), sendNow: jest.fn(), isEnabled: jest.fn().mockReturnValue(true) };
  const sweeper = { requeueStranded: jest.fn(), failAbandonedSends: jest.fn(), requeueStrandedMessages: jest.fn() };

  const NOTIFICATION_ID = '4b3c2d1e-0f9a-4b8c-9d7e-6f5a4b3c2d1e';
  const smsRow = (over: Partial<NotificationEntity> = {}): Partial<NotificationEntity> => ({
    id: NOTIFICATION_ID,
    userId: 'u-1',
    assayerId: null,
    type: 'ASSIGNMENT_SLA_BREACH',
    title: 'Assignment SLA breached',
    message: 'ASN-1 is 3h past its response SLA.',
    link: '/assignments?id=asn-1',
    category: 'ASSIGNMENT' as any,
    channels: [NotificationChannel.IN_APP, NotificationChannel.SMS],
    status: NotificationStatus.DELIVERED,
    emailStatus: null,
    smsStatus: NotificationStatus.PENDING,
    ...over,
  });

  const job = (over: any = {}) =>
    ({ data: { notificationId: NOTIFICATION_ID }, attemptsMade: 0, opts: { attempts: 5 }, ...over } as any);

  const lastSmsStatus = () => [...updates].reverse().find((u) => u.smsStatus)?.smsStatus;
  const lastReason = () => [...updates].reverse().find((u) => u.smsFailureReason !== undefined)?.smsFailureReason;
  const queuedRequest = () => smsService.queue.mock.calls[0]?.[0];
  const claim = () => builderCalls[0];
  /** Any write this job made that named an email column. There must never be one. */
  const emailColumnWrites = () => [...updates, ...builderCalls.map((c) => c.set)]
    .filter((patch) => Object.keys(patch ?? {}).some((k) => k.startsWith('email')));

  beforeEach(async () => {
    updates = [];
    builderCalls = [];
    affectedQueue = [];
    jest.clearAllMocks();
    smsService.queue.mockResolvedValue({ id: 's-1', channel: 'SMS', status: 'QUEUED', to: '+919800000001' });
    smsService.isEnabled.mockReturnValue(true);
    prefRepo.findOne.mockResolvedValue(null);
    assayerRepo.findOne.mockResolvedValue(null);
    userRepo.findOne.mockResolvedValue({ id: 'u-1', phone: '+919800000001', displayName: 'Ramesh Kumar', isActive: true, status: 'ACTIVE' });

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
        { provide: SmsService, useValue: smsService },
        { provide: NotificationSettingsService, useValue: { defFor: jest.fn(async () => null), effectiveCatalog: jest.fn(async () => ({})) } },
        { provide: NotificationSweeper, useValue: sweeper },
      ],
    }).compile();

    worker = module.get(NotificationDeliveryWorker);
  });

  it('hands the text to the SMS queue, as a notification text about this notification, in the notification template', async () => {
    notifRepo.findOne.mockResolvedValue(smsRow());

    await worker.deliverSms(job());

    expect(smsService.queue).toHaveBeenCalledTimes(1);
    expect(queuedRequest()).toEqual({
      kind: 'NOTIFICATION',
      to: '+919800000001',
      entityType: 'NOTIFICATION',
      entityId: NOTIFICATION_ID,
      requestedBy: null,
      // Their name travels with the text, so `{{name}}` reads as a name in the registered wording.
      recipientName: 'Ramesh Kumar',
      content: {
        template: 'notification',
        data: { title: 'Assignment SLA breached', message: 'ASN-1 is 3h past its response SLA.' },
      },
    });
    // It never sends anything itself, and never touches the email leg.
    expect(smsService.sendNow).not.toHaveBeenCalled();
    expect(emailService.queue).not.toHaveBeenCalled();
  });

  it('claims sms_status PENDING → SENT before handing it over, leaves it SENT, and never writes an email column', async () => {
    notifRepo.findOne.mockResolvedValue(smsRow());

    await worker.deliverSms(job());

    expect(claim().where).toEqual({
      'id = :id': { id: NOTIFICATION_ID },
      'sms_status = :pending': { pending: NotificationStatus.PENDING },
    });
    expect(claim().set).toEqual({ smsStatus: NotificationStatus.SENT, textedAt: expect.any(Date) });
    // Claimed first, handed over second: a hand-off with no claim is how a duplicate job doubles it.
    expect(notifRepo.createQueryBuilder.mock.invocationCallOrder[0])
      .toBeLessThan(smsService.queue.mock.invocationCallOrder[0]);
    // Nothing after the hand-off: DELIVERED is the SMS queue's to write, once the text went.
    expect(builderCalls).toHaveLength(1);
    expect(updates).toHaveLength(0);
    expect(emailColumnWrites()).toEqual([]);
  });

  it('hands over the notification\'s own title and message — fitting them to DLT is the template\'s one rule', async () => {
    notifRepo.findOne.mockResolvedValue(smsRow({ title: 'T'.repeat(200), message: 'Long message' }));

    await worker.deliverSms(job());

    expect(queuedRequest().content.data).toEqual({ title: 'T'.repeat(200), message: 'Long message' });
  });

  it('does nothing for a row already handed over or settled — a duplicate job cannot hand it over twice', async () => {
    for (const smsStatus of [NotificationStatus.SENT, NotificationStatus.DELIVERED, NotificationStatus.FAILED, NotificationStatus.SUPPRESSED]) {
      notifRepo.findOne.mockResolvedValue(smsRow({ smsStatus }));
      await worker.deliverSms(job());
    }
    expect(smsService.queue).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(builderCalls).toHaveLength(0);
  });

  it('does nothing for a row that never owed a text, even when it still owes an email', async () => {
    notifRepo.findOne.mockResolvedValue(smsRow({ smsStatus: null, emailStatus: NotificationStatus.PENDING }));
    await worker.deliverSms(job());
    expect(smsService.queue).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('stops without handing over when another job already claimed the row', async () => {
    // The sweeper re-enqueues anything PENDING for five minutes; two jobs then race, and exactly
    // one may hand the text over — or the recipient pays for, and reads, it twice.
    notifRepo.findOne.mockResolvedValue(smsRow());
    affectedQueue = [0];

    await worker.deliverSms(job());

    expect(smsService.queue).not.toHaveBeenCalled();
  });

  it('gives the claim back and throws when the queue did not take it, so Bull tries the hand-off again', async () => {
    notifRepo.findOne.mockResolvedValue(smsRow());
    smsService.queue.mockResolvedValue({
      id: null, channel: 'SMS', status: 'NOT_QUEUED', to: '+919800000001', error: 'The text could not be prepared. Hand the details over another way.',
    });

    await expect(worker.deliverSms(job())).rejects.toThrow('could not be prepared');

    const putBack = builderCalls[1];
    expect(putBack.set).toEqual({
      smsStatus: NotificationStatus.PENDING,
      smsFailureReason: 'The text could not be prepared. Hand the details over another way.',
    });
    // Conditional: only a row this job still holds as SENT goes back to PENDING.
    expect(putBack.where).toEqual({
      'id = :id': { id: NOTIFICATION_ID },
      'sms_status = :handedOff': { handedOff: NotificationStatus.SENT },
    });
  });

  it('settles FAILED on the last attempt instead of putting it back for the sweeper to re-queue for ever', async () => {
    notifRepo.findOne.mockResolvedValue(smsRow());
    smsService.queue.mockResolvedValue({ id: null, channel: 'SMS', status: 'NOT_QUEUED', to: '', error: 'There is no phone number to send to.' });

    await expect(worker.deliverSms(job({ attemptsMade: 4 }))).resolves.toBeUndefined();

    const settle = builderCalls[1];
    expect(settle.set.smsStatus).toBe(NotificationStatus.FAILED);
    expect(settle.set.smsFailureReason).toMatch(/no phone number.*after 5 attempts/);
    expect(settle.where['sms_status = :handedOff']).toEqual({ handedOff: NotificationStatus.SENT });
  });

  it('honours an explicit SMS opt-out for the category', async () => {
    notifRepo.findOne.mockResolvedValue(smsRow());
    prefRepo.findOne.mockResolvedValue({ inApp: true, push: true, email: true, sms: false });

    await worker.deliverSms(job());

    expect(smsService.queue).not.toHaveBeenCalled();
    expect(lastSmsStatus()).toBe(NotificationStatus.SUPPRESSED);
    expect(lastReason()).toMatch(/turned off SMS/);
    expect(emailColumnWrites()).toEqual([]);
  });

  it('does not read an email opt-out as an SMS opt-out — each channel has its own switch', async () => {
    notifRepo.findOne.mockResolvedValue(smsRow());
    prefRepo.findOne.mockResolvedValue({ inApp: true, push: true, email: false, sms: true });

    await worker.deliverSms(job());

    expect(smsService.queue).toHaveBeenCalled();
  });

  it('honours an assayer’s SMS opt-out too — a text lands on their personal phone', async () => {
    notifRepo.findOne.mockResolvedValue(smsRow({ userId: null, assayerId: 'as-1' }));
    assayerRepo.findOne.mockResolvedValue({ id: 'as-1', phone: '9800000002', status: 'ACTIVE' });
    prefRepo.findOne.mockResolvedValue({ sms: false });

    await worker.deliverSms(job());

    expect(prefRepo.findOne).toHaveBeenCalledWith({ where: { assayerId: 'as-1', category: 'ASSIGNMENT' } });
    expect(smsService.queue).not.toHaveBeenCalled();
    expect(lastSmsStatus()).toBe(NotificationStatus.SUPPRESSED);
  });

  it('treats a missing preference row as opted in — the house convention', async () => {
    notifRepo.findOne.mockResolvedValue(smsRow());
    prefRepo.findOne.mockResolvedValue(null);
    await worker.deliverSms(job());
    expect(smsService.queue).toHaveBeenCalled();
  });

  it.each([
    ['no phone at all', null],
    ['a phone that is only whitespace', '   '],
  ])('suppresses, with the reason, a staff recipient with %s rather than failing five times', async (_case, phone) => {
    notifRepo.findOne.mockResolvedValue(smsRow());
    userRepo.findOne.mockResolvedValue({ id: 'u-1', phone, isActive: true, status: 'ACTIVE' });

    await worker.deliverSms(job());

    expect(smsService.queue).not.toHaveBeenCalled();
    expect(lastSmsStatus()).toBe(NotificationStatus.SUPPRESSED);
    expect(lastReason()).toMatch(/no mobile number on file/);
  });

  it('texts an assayer recipient at the phone on their record', async () => {
    notifRepo.findOne.mockResolvedValue(smsRow({ userId: null, assayerId: 'as-1' }));
    assayerRepo.findOne.mockResolvedValue({ id: 'as-1', phone: '9800000002', status: 'ACTIVE' });

    await worker.deliverSms(job());

    expect(queuedRequest()).toEqual(expect.objectContaining({ to: '9800000002' }));
  });

  it('suppresses, with the reason, when an assayer recipient has no phone on file', async () => {
    notifRepo.findOne.mockResolvedValue(smsRow({ userId: null, assayerId: 'as-1' }));
    assayerRepo.findOne.mockResolvedValue({ id: 'as-1', phone: null, status: 'ACTIVE' });

    await worker.deliverSms(job());

    expect(smsService.queue).not.toHaveBeenCalled();
    expect(lastSmsStatus()).toBe(NotificationStatus.SUPPRESSED);
    expect(lastReason()).toMatch(/Field assayer has no mobile number on file/);
  });

  it('suppresses a row addressed to nobody instead of reading a phone for nobody', async () => {
    notifRepo.findOne.mockResolvedValue(smsRow({ userId: null, assayerId: null }));
    await worker.deliverSms(job());
    expect(smsService.queue).not.toHaveBeenCalled();
    expect(lastSmsStatus()).toBe(NotificationStatus.SUPPRESSED);
  });

  it('does not text an account suspended since dispatch', async () => {
    notifRepo.findOne.mockResolvedValue(smsRow());
    userRepo.findOne.mockResolvedValue({ id: 'u-1', phone: '9800000001', isActive: true, status: 'SUSPENDED' });

    await worker.deliverSms(job());

    expect(smsService.queue).not.toHaveBeenCalled();
    expect(lastSmsStatus()).toBe(NotificationStatus.SUPPRESSED);
    expect(lastReason()).toBe('Recipient account is suspended.');
  });

  it('does not text a suspended field assayer', async () => {
    notifRepo.findOne.mockResolvedValue(smsRow({ userId: null, assayerId: 'as-1' }));
    assayerRepo.findOne.mockResolvedValue({ id: 'as-1', phone: '9800000002', status: 'SUSPENDED' });

    await worker.deliverSms(job());

    expect(smsService.queue).not.toHaveBeenCalled();
    expect(lastReason()).toBe('Field assayer account is suspended.');
  });

  it('still texts an account locked out by failed sign-ins — the same cut-off rule email follows', async () => {
    notifRepo.findOne.mockResolvedValue(smsRow());
    userRepo.findOne.mockResolvedValue({ id: 'u-1', phone: '9800000001', isActive: true, status: 'LOCKED' });

    await worker.deliverSms(job());

    expect(smsService.queue).toHaveBeenCalled();
  });

  it('does not decide "SMS is not set up" itself — the sending worker does, and the notification lands SUPPRESSED', async () => {
    // A replica without the gateway credential must not silence a row a configured sender could deliver.
    notifRepo.findOne.mockResolvedValue(smsRow());
    smsService.isEnabled.mockReturnValue(false);

    await worker.deliverSms(job());

    expect(smsService.queue).toHaveBeenCalled();
    expect(lastSmsStatus()).toBeUndefined();
  });

  it('the sweep job re-queues stranded texts as well as stranded emails', async () => {
    // Without the SMS call a text whose enqueue missed Redis would sit PENDING for ever.
    await worker.sweep();
    expect(sweeper.requeueStrandedMessages).toHaveBeenCalledWith('EMAIL');
    expect(sweeper.requeueStrandedMessages).toHaveBeenCalledWith('SMS');
  });
});
